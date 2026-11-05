import { describe, expect, it } from "vitest";
import type { Reading } from "../src/domain/models.js";
import { normalizeReadings, parsePortalTimestamp, toConsumption } from "../src/domain/readings.js";
import { rawReadings } from "./helpers.js";

const IST = "+05:30";

describe("parsePortalTimestamp", () => {
  it("converts DD/MM/YYYY HH:mm to ISO 8601 with offset", () => {
    expect(parsePortalTimestamp("24/06/2026 00:30", IST)).toBe("2026-06-24T00:30:00+05:30");
  });

  it("rejects other formats", () => {
    expect(parsePortalTimestamp("2026-06-24 00:30", IST)).toBeNull();
    expect(parsePortalTimestamp("", IST)).toBeNull();
  });
});

describe("normalizeReadings", () => {
  it("parses half-hourly data and infers PT30M", () => {
    const { readings, interval, issues } = normalizeReadings("J100000", rawReadings("energy-J100000-halfhourly.json"), IST);
    expect(interval).toBe("PT30M");
    expect(issues).toEqual([]);
    expect(readings[0]).toEqual({
      timestamp: "2026-06-01T00:00:00+05:30",
      cumulativeKwh: expect.any(Number),
      cumulativeKvah: expect.any(Number),
      voltageR: expect.any(Number),
    });
  });

  it("infers P1D for meters that report once a day", () => {
    expect(normalizeReadings("J100040", rawReadings("energy-J100040-daily.json"), IST).interval).toBe("P1D");
  });

  it("drops the empty duplicate row the portal appends for some meters", () => {
    const raw = rawReadings("energy-J100089-duplicate.json");
    expect(raw).toHaveLength(31);

    const { readings, issues } = normalizeReadings("J100089", raw, IST);
    expect(readings).toHaveLength(30);
    expect(readings.at(-1)?.cumulativeKwh).not.toBeNull();
    expect(issues).toMatchObject([{ type: "duplicate_reading_dropped", entity: "meter:J100089" }]);
  });

  it("turns empty strings into null instead of 0", () => {
    const { readings } = normalizeReadings("X", [{ timestamp: "01/06/2026 00:00", kwh: "", kvah: "1.5", voltR: null }], IST);
    expect(readings[0]).toMatchObject({ cumulativeKwh: null, cumulativeKvah: 1.5, voltageR: null });
  });
});

describe("toConsumption", () => {
  const r = (timestamp: string, kwh: number | null): Reading => ({
    timestamp,
    cumulativeKwh: kwh,
    cumulativeKvah: kwh === null ? null : kwh * 1.1,
    voltageR: 230,
  });

  it("derives usage from register deltas", () => {
    const readings = [r("2026-06-01T00:00:00+05:30", 100), r("2026-06-01T00:30:00+05:30", 100.4), r("2026-06-01T01:00:00+05:30", 101)];
    const result = toConsumption("X", readings, "interval", IST);
    expect(result.points.map((p) => p.kwh)).toEqual([0.4, 0.6]);
    expect(result.totalKwh).toBe(1);
  });

  it("rolls intervals up to days and respects the window", () => {
    const readings = [
      r("2026-06-01T00:00:00+05:30", 0),
      r("2026-06-01T12:00:00+05:30", 5),
      r("2026-06-02T00:00:00+05:30", 12),
      r("2026-06-03T00:00:00+05:30", 20),
    ];
    const result = toConsumption("X", readings, "day", IST, { from: "2026-06-01", to: "2026-06-01" });
    expect(result.points).toEqual([
      { start: "2026-06-01T00:00:00+05:30", end: "2026-06-02T00:00:00+05:30", kwh: 12, kvah: 13.2 },
    ]);
  });

  it("reports a decreasing register instead of returning negative usage", () => {
    const readings = [r("2026-06-01T00:00:00+05:30", 50), r("2026-06-02T00:00:00+05:30", 3)];
    const result = toConsumption("X", readings, "interval", IST);
    expect(result.points[0]?.kwh).toBeNull();
    expect(result.issues).toMatchObject([{ type: "register_decreased" }]);
  });

  it("leaves a gap as null when a reading is missing", () => {
    const readings = [r("2026-06-01T00:00:00+05:30", 1), r("2026-06-01T00:30:00+05:30", null), r("2026-06-01T01:00:00+05:30", 2)];
    expect(toConsumption("X", readings, "interval", IST).points.map((p) => p.kwh)).toEqual([null, null]);
  });
});
