/**
 * At most `limit()` requests at a time; the others wait their turn, first
 * come first served. The JMAP client keeps its API requests and session
 * fetches within the server's maxConcurrentRequests with it: Stalwart
 * refuses the surplus of a burst (default 4 per user), and the start of the
 * app sends a dozen and more at once (#172). The limit is read on every
 * request, so it follows the session; a limit that is not a positive number
 * means none.
 */
export class RequestSlots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: () => number | undefined) {}

  private get max(): number {
    const n = this.limit();
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
  }

  /** Runs `send` once a slot is free and frees the slot when it settles. */
  async run<T>(send: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await send();
    } finally {
      this.release();
    }
  }

  /** Requests running now. */
  get running(): number {
    return this.active;
  }

  private acquire(): Promise<void> {
    if (this.active < this.max && this.waiting.length === 0) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active -= 1;
    // Whoever waits takes the slot at once (counted here, before anything
    // else runs), so a request that comes in meanwhile cannot take it as
    // well. A limit that went down drops slots; one that went up (a new
    // session) lets more of the line through.
    while (this.waiting.length > 0 && this.active < this.max) {
      this.active += 1;
      this.waiting.shift()!();
    }
  }
}
