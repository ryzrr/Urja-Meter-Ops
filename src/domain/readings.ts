import { addDays } from "../lib/dates.js";
import type { RawReading } from "../portal/schemas.js";
import type { ConsumptionPoint, DataIssue, Reading } from "./models.js";

const PORTAL_TIMESTAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;

/** "24/06/2026 00:30" (portal local time, no zone) -> "2026-06-24T00:30:00+05:30" */
export function parsePortalTimestamp(value: string, utcOffset: string): string | null {
  const m = PORTAL_TIMESTAMP.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:00${utcOffset}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface NormalizedReadings {
  readings: Reading[];
  /** ISO 8601 duration of the typical gap between readings, e.g. PT30M or P1D. */
  interval: string | null;
  issues: DataIssue[];
}

/**
 * Parses timestamps and numbers, drops duplicate timestamps (keeping the most complete
 * row) and sorts. Some meters report every 30 minutes, others once a day at midnight;
 * the portal does not say which, so the interval is inferred from the data.
 */
export function normalizeReadings(meterId: string, raw: RawReading[], utcOffset: string): NormalizedReadings {
  const entity = `meter:${meterId}`;
  const issues: DataIssue[] = [];
  const byTimestamp = new Map<string, Reading>();

  for (const row of raw) {
    const timestamp = parsePortalTimestamp(row.timestamp, utcOffset);
    if (!timestamp) {
      issues.push({ type: "unresolved_value", entity, field: "timestamp", message: `Unparseable timestamp "${row.timestamp}"; row skipped.` });
      continue;
    }
    const reading: Reading = {
      timestamp,
      cumulativeKwh: toNumber(row.kwh),
      cumulativeKvah: toNumber(row.kvah),
      voltageR: toNumber(row.voltR),
    };
    const existing = byTimestamp.get(timestamp);
    if (existing) {
      const keep = completeness(reading) > completeness(existing) ? reading : existing;
      byTimestamp.set(timestamp, keep);
      issues.push({ type: "duplicate_reading_dropped", entity, field: "timestamp", message: `Duplicate reading at ${timestamp}; kept the more complete row.` });
      continue;
    }
    byTimestamp.set(timestamp, reading);
  }

  const readings = [...byTimestamp.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return { readings, interval: inferInterval(readings), issues };
}

function completeness(r: Reading): number {
  return [r.cumulativeKwh, r.cumulativeKvah, r.voltageR].filter((v) => v !== null).length;
}

function inferInterval(readings: Reading[]): string | null {
  if (readings.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < readings.length; i++) {
    gaps.push((Date.parse(readings[i]!.timestamp) - Date.parse(readings[i - 1]!.timestamp)) / 60_000);
  }
  gaps.sort((a, b) => a - b);
  const minutes = gaps[Math.floor(gaps.length / 2)]!;
  if (minutes > 0 && minutes % 1440 === 0) return `P${minutes / 1440}D`;
  if (minutes > 0 && minutes % 60 === 0) return `PT${minutes / 60}H`;
  return minutes > 0 ? `PT${minutes}M` : null;
}

export type Granularity = "interval" | "day";

export interface ConsumptionResult {
  points: ConsumptionPoint[];
  totalKwh: number | null;
  totalKvah: number | null;
  issues: DataIssue[];
}

/**
 * kWh and kVAh from the portal are cumulative registers, so usage for an interval is the
 * difference between consecutive readings. A negative difference (meter reset, replacement
 * or bad data) is reported and left as null rather than counted.
 *
 * `window` keeps only intervals that start on a date inside [from, to] (portal local time).
 */
export function toConsumption(
  meterId: string,
  readings: Reading[],
  granularity: Granularity,
  utcOffset: string,
  window?: { from: string; to: string },
): ConsumptionResult {
  const issues: DataIssue[] = [];
  let points: ConsumptionPoint[] = [];

  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]!;
    const cur = readings[i]!;
    const kwh = delta(prev.cumulativeKwh, cur.cumulativeKwh);
    const kvah = delta(prev.cumulativeKvah, cur.cumulativeKvah);
    if ((kwh !== null && kwh < 0) || (kvah !== null && kvah < 0)) {
      issues.push({
        type: "register_decreased",
        entity: `meter:${meterId}`,
        field: "cumulativeKwh",
        message: `Register went down between ${prev.timestamp} and ${cur.timestamp}; interval left as null.`,
      });
    }
    points.push({
      start: prev.timestamp,
      end: cur.timestamp,
      kwh: kwh !== null && kwh >= 0 ? kwh : null,
      kvah: kvah !== null && kvah >= 0 ? kvah : null,
    });
  }

  if (window) {
    points = points.filter((p) => {
      const day = p.start.slice(0, 10);
      return day >= window.from && day <= window.to;
    });
  }
  if (granularity === "day") points = rollUpByDay(points, utcOffset);

  return { points, totalKwh: sum(points.map((p) => p.kwh)), totalKvah: sum(points.map((p) => p.kvah)), issues };
}

function rollUpByDay(points: ConsumptionPoint[], utcOffset: string): ConsumptionPoint[] {
  const days = new Map<string, ConsumptionPoint[]>();
  for (const p of points) {
    const day = p.start.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), p]);
  }
  return [...days].map(([day, group]) => ({
    start: `${day}T00:00:00${utcOffset}`,
    end: `${addDays(day, 1)}T00:00:00${utcOffset}`,
    kwh: sum(group.map((p) => p.kwh)),
    kvah: sum(group.map((p) => p.kvah)),
  }));
}

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : round3(b - a);
}

function sum(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? round3(present.reduce((acc, v) => acc + v, 0)) : null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
