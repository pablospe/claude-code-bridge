import type { ClaudeCodeBridge } from "@ccb/core";

export interface SessionPoolOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly size: number;
}

interface Waiter {
  readonly resolve: (sessionId: string) => void;
  readonly reject: (err: Error) => void;
}

/**
 * Fixed-size pool of warm bridge sessions. One in-flight turn per session;
 * excess callers queue FIFO. Every turn gets a cleared session. A turn that
 * throws is assumed to have poisoned its session: the session is closed
 * (best effort) and replaced with a fresh one before the next waiter runs.
 *
 * A failed respawn rejects all queued waiters and shrinks the pool, so callers
 * fail fast instead of hanging on a session that will never come. close()
 * likewise rejects any queued waiters, and also closes sessions currently
 * checked out by an in-flight turn — aborting that turn — so close() does not
 * resolve while a claude PTY still runs.
 */
export class SessionPool {
  readonly #bridge: ClaudeCodeBridge;
  readonly #size: number;
  readonly #idle: string[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #checkedOut = new Set<string>();
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
    try {
      for (let i = 0; i < this.#size; i++) {
        const { id } = await this.#bridge.startSession({});
        this.#idle.push(id);
      }
    } catch (err) {
      const warmed = this.#idle.splice(0);
      await Promise.allSettled(warmed.map((id) => this.#bridge.close(id)));
      throw err;
    }
  }

  async withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("pool is closed");
    const sessionId = await this.#acquire();
    this.#checkedOut.add(sessionId);
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
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error("pool is closed"));
    }
    const ids = [...this.#idle.splice(0), ...this.#checkedOut];
    this.#checkedOut.clear();
    await Promise.allSettled(ids.map((id) => this.#bridge.close(id)));
  }

  #acquire(): Promise<string> {
    const id = this.#idle.shift();
    if (id !== undefined) return Promise.resolve(id);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #release(sessionId: string): void {
    this.#checkedOut.delete(sessionId);
    const waiter = this.#waiters.shift();
    if (waiter) {
      this.#checkedOut.add(sessionId);
      waiter.resolve(sessionId);
      return;
    }
    if (this.#closed) {
      // close() already drained #idle; a turn that was in flight at close
      // time would otherwise strand its session there unclosed.
      void this.#bridge.close(sessionId).catch(() => undefined);
      return;
    }
    this.#idle.push(sessionId);
  }

  async #replace(sessionId: string): Promise<void> {
    this.#checkedOut.delete(sessionId);
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
      console.error(`SessionPool: respawn failed: ${String(err)}`);
      // The pool just lost a session, so fairness among queued waiters is
      // murky. Rather than starve them on a session that will never come,
      // reject every queued waiter and let callers fail fast.
      const error = new Error(`session respawn failed: ${String(err)}`);
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(error);
      }
    }
  }
}
