import { buildCatalog } from "../domain/catalog.js";
import type { DataIssue, Meter, NetworkNode, Transformer } from "../domain/models.js";
import { buildNetwork } from "../domain/network.js";
import type { PortalSource } from "../portal/client.js";

export interface CatalogSnapshot {
  meters: Meter[];
  meterById: Map<string, Meter>;
  transformers: Transformer[];
  network: NetworkNode[];
  issues: DataIssue[];
  loadedAt: Date;
}

export interface CatalogStatus {
  loaded: boolean;
  loadedAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  meterCount: number;
  lastRefreshError: string | null;
}

/**
 * Holds an in-memory snapshot of meters, transformers and the network, built from the
 * signed bulk export (1 request) and the transformer list (2 requests).
 *
 * Freshness: the snapshot is served for `ttlMs`. After that, the next read triggers a
 * background refresh and keeps serving the old snapshot until the new one is ready
 * (stale-while-revalidate). If the portal is down, the old snapshot keeps being served
 * and the failure is visible in /health.
 */
export class CatalogService {
  private current: CatalogSnapshot | null = null;
  private pending: Promise<CatalogSnapshot> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly portal: PortalSource,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string) => void = (msg) => console.warn(msg),
  ) {}

  async get(): Promise<CatalogSnapshot> {
    if (!this.current) return this.refresh();
    if (this.isStale()) {
      this.refresh().catch((err: unknown) => this.log(`Background catalog refresh failed: ${String(err)}`));
    }
    return this.current;
  }

  /** Loads a new snapshot. Concurrent callers share the same load. */
  refresh(): Promise<CatalogSnapshot> {
    this.pending ??= this.load()
      .then((snapshot) => {
        this.current = snapshot;
        this.lastError = null;
        return snapshot;
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  status(): CatalogStatus {
    const loadedAt = this.current?.loadedAt ?? null;
    return {
      loaded: loadedAt !== null,
      loadedAt: loadedAt?.toISOString() ?? null,
      ageSeconds: loadedAt ? Math.round((this.now() - loadedAt.getTime()) / 1000) : null,
      stale: this.isStale(),
      meterCount: this.current?.meters.length ?? 0,
      lastRefreshError: this.lastError,
    };
  }

  private isStale(): boolean {
    return !this.current || this.now() - this.current.loadedAt.getTime() > this.ttlMs;
  }

  private async load(): Promise<CatalogSnapshot> {
    const [rawMeters, rawTransformers] = await Promise.all([
      this.portal.exportMeters(),
      this.portal.listTransformers(),
    ]);
    const { meters, transformers, issues } = buildCatalog(rawMeters, rawTransformers);
    return {
      meters,
      meterById: new Map(meters.map((m) => [m.meterId, m])),
      transformers,
      network: buildNetwork(meters),
      issues,
      loadedAt: new Date(this.now()),
    };
  }
}
