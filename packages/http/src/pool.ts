import type { ClaudeCodeBridge } from "@ccb/core";

export interface SessionPoolOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly size: number;
}

/**
 * Fixed-size pool of warm bridge sessions. One in-flight turn per session;
 * excess callers queue FIFO. Every turn gets a cleared session. A turn that
 * throws is assumed to have poisoned its session: the session is closed
 * (best effort) and replaced with a fresh one before the next waiter runs.
 */
export class SessionPool {
  readonly #bridge: ClaudeCodeBridge;
  readonly #size: number;
  readonly #idle: string[] = [];
  readonly #waiters: Array<(sessionId: string) => void> = [];
  #closed = false;

  constructor(options: SessionPoolOptions) {
    if (options.size < 1) throw new Error("pool size must be >= 1");
    this.#bridge = options.bridge;
    this.#size = options.size;
  }

  /** The bridge the pool wraps; turn executors run against it. */
  get bridge(): ClaudeCodeBridge {
    return this.#bridge;
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.#size; i++) {
      const { id } = await this.#bridge.startSession({});
      this.#idle.push(id);
    }
  }

  async withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("pool is closed");
    const sessionId = await this.#acquire();
    try {
      await this.#bridge.clear(sessionId);
      const result = await fn(sessionId);
      this.#release(sessionId);
      return result;
    } catch (err) {
      await this.#replace(sessionId);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const ids = this.#idle.splice(0);
    await Promise.allSettled(ids.map((id) => this.#bridge.close(id)));
  }

  #acquire(): Promise<string> {
    const id = this.#idle.shift();
    if (id !== undefined) return Promise.resolve(id);
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(sessionId: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(sessionId);
    else this.#idle.push(sessionId);
  }

  async #replace(sessionId: string): Promise<void> {
    try {
      await this.#bridge.close(sessionId);
    } catch {
      // already dead — that's why we're replacing it
    }
    if (this.#closed) return;
    try {
      const { id } = await this.#bridge.startSession({});
      this.#release(id);
    } catch (err) {
      // Pool shrinks if respawn fails; surfaces as queue starvation rather
      // than a hidden crash loop.
      console.error(`SessionPool: respawn failed: ${String(err)}`);
    }
  }
}
