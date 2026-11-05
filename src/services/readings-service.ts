import type { ConsumptionPoint, DataIssue, Reading } from "../domain/models.js";
import { normalizeReadings, toConsumption, type Granularity } from "../domain/readings.js";
import { addDays } from "../lib/dates.js";
import { TtlCache } from "../lib/ttl-cache.js";
import type { PortalSource } from "../portal/client.js";
import type { RawReading } from "../portal/schemas.js";

export interface DateRange {
  from: string;
  to: string;
}

export interface ReadingsOptions {
  utcOffset: string;
  /** How long a fetched window is reused before asking the portal again. */
  ttlMs: number;
  now?: () => number;
}

export interface ReadingsResult {
  from: string | null;
  to: string | null;
  interval: string | null;
  readings: Reading[];
  issues: DataIssue[];
}

export interface ConsumptionResultWithRange {
  from: string | null;
  to: string | null;
  interval: string | null;
  points: ConsumptionPoint[];
  totalKwh: number | null;
  totalKvah: number | null;
  issues: DataIssue[];
}

export class ReadingsService {
  private readonly cache: TtlCache<RawReading[]>;
  private readonly now: () => number;

  constructor(
    private readonly portal: PortalSource,
    private readonly options: ReadingsOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.cache = new TtlCache(1000, this.now);
  }

  /** Register readings as the portal reports them, cleaned. No range = portal default (last 7 days of data). */
  async readings(meterId: string, range?: DateRange): Promise<ReadingsResult> {
    const raw = await this.fetch(meterId, range);
    const { readings, interval, issues } = normalizeReadings(meterId, raw, this.options.utcOffset);
    return {
      from: range?.from ?? readings[0]?.timestamp.slice(0, 10) ?? null,
      to: range?.to ?? readings.at(-1)?.timestamp.slice(0, 10) ?? null,
      interval,
      readings,
      issues,
    };
  }

  /**
   * Usage per interval or per day. The fetch is extended by one day past `to` so the last
   * interval of the window can be closed (day D's usage needs the reading at D+1 00:00).
   */
  async consumption(meterId: string, granularity: Granularity, range?: DateRange): Promise<ConsumptionResultWithRange> {
    const fetchRange = range ? { from: range.from, to: addDays(range.to, 1) } : undefined;
    const raw = await this.fetch(meterId, fetchRange);
    const normalized = normalizeReadings(meterId, raw, this.options.utcOffset);
    const { readings } = normalized;
    const result = toConsumption(meterId, readings, granularity, this.options.utcOffset, range);
    return {
      from: range?.from ?? readings[0]?.timestamp.slice(0, 10) ?? null,
      to: range?.to ?? readings.at(-1)?.timestamp.slice(0, 10) ?? null,
      interval: normalized.interval,
      ...result,
      issues: [...normalized.issues, ...result.issues],
    };
  }

  private fetch(meterId: string, range?: DateRange): Promise<RawReading[]> {
    const key = `${meterId}|${range?.from ?? ""}|${range?.to ?? ""}`;
    return this.cache.getOrLoad(key, this.options.ttlMs, () => this.portal.getReadings(meterId, range));
  }
}
