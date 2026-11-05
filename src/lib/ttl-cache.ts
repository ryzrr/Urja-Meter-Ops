interface Entry<V> {
  value: Promise<V>;
  expiresAt: number;
}

/**
 * Small in-memory cache of promises with a per-entry TTL and a size cap (oldest entry is
 * evicted first). Caching the promise means concurrent requests for the same key share a
 * single upstream call. Failed loads are not cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  getOrLoad(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  get size(): number {
    return this.entries.size;
  }
}
