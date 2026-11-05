export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding window limiter shared by every portal request.
 *
 * The portal returns 429 after about 120 requests in a 30 second window and sends no
 * Retry-After header, so we throttle ourselves below that and pause everyone when a
 * 429 slips through anyway (e.g. another client using the same account).
 */
export class RateLimiter {
  private stamps: number[] = [];
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  /** Resolves when the caller may send one request. Callers are served in FIFO order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /** Block all callers for `ms` (used after a 429). */
  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      const oldest = this.stamps[0] ?? now;
      await this.sleep(this.windowMs - (now - oldest) + 1);
    }
  }
}
