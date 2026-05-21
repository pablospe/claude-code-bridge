import type { BridgeEvent } from "./events.ts";
import { truncateHookPayload } from "./hooks.ts";
import type { SupervisorContext } from "./supervisor.ts";

export interface HookFaninOptions {
  /**
   * Maximum number of hook frames buffered while waiting for the channel
   * server's first `hello`. On overflow, the oldest queued frame is dropped
   * and `metrics().preHelloHookDrops` is incremented. Defaults to 100.
   */
  readonly queueCap?: number;
}

export interface HookFaninMetrics {
  /**
   * Count of hook frames dropped due to pre-hello queue overflow for this
   * session. Not a `BridgeEvent` — surfaced only for tests and diagnostics.
   */
  readonly preHelloHookDrops: number;
  /**
   * Current depth of the pre-hello queue. Zero after `onHello()` flushes.
   */
  readonly pendingQueueDepth: number;
}

const DEFAULT_QUEUE_CAP = 100;

interface QueuedHook {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/**
 * Per-session fan-in for hook frames. The bridge accepts hook frames before
 * the channel server's first `hello` lands; they are queued (cap 100, oldest
 * dropped) and flushed when `onHello()` fires. After `onPeerClose()` the
 * session is shutting down — queue is discarded and subsequent hooks are
 * dropped silently (the contract M3.md pins).
 *
 * Truncation is applied at queue-time so the queue's memory footprint is
 * bounded by `cap * (sum of per-field caps)` rather than by the raw payload
 * size, which can be arbitrarily large for a long `tool_result` etc.
 */
export class HookFanin {
  readonly #ctx: SupervisorContext;
  readonly #queueCap: number;
  readonly #queue: QueuedHook[] = [];
  #helloReceived = false;
  #closed = false;
  #droppedCount = 0;

  constructor(ctx: SupervisorContext, opts: HookFaninOptions = {}) {
    this.#ctx = ctx;
    this.#queueCap = opts.queueCap ?? DEFAULT_QUEUE_CAP;
  }

  /**
   * Process a hook frame. If the channel-server hello has already arrived,
   * emit immediately. Otherwise, truncate-and-queue (oldest-dropped on
   * overflow). After `onPeerClose()`, drop silently.
   */
  onHook(event: string, payload: Record<string, unknown>): void {
    if (this.#closed) return;
    const data = truncateHookPayload(payload);
    if (this.#helloReceived) {
      this.#emit(event, data);
      return;
    }
    if (this.#queue.length >= this.#queueCap) {
      this.#queue.shift();
      this.#droppedCount++;
    }
    this.#queue.push({ event, data });
  }

  /**
   * Channel-server hello arrived. Flush the pre-hello queue in arrival order.
   * Idempotent: a second hello call is a no-op (queue is already drained).
   * If `onPeerClose()` fires mid-flush, abort cleanly.
   */
  onHello(): void {
    if (this.#helloReceived) return;
    this.#helloReceived = true;
    while (this.#queue.length > 0) {
      if (this.#closed) {
        this.#queue.length = 0;
        return;
      }
      const item = this.#queue.shift();
      if (!item) break;
      this.#emit(item.event, item.data);
    }
  }

  /**
   * Channel-server peer dropped its socket. Discard any queued frames and
   * mark closed so subsequent `onHook()` calls drop silently.
   */
  onPeerClose(): void {
    this.#closed = true;
    this.#queue.length = 0;
  }

  metrics(): HookFaninMetrics {
    return {
      preHelloHookDrops: this.#droppedCount,
      pendingQueueDepth: this.#queue.length,
    };
  }

  #emit(event: string, data: Record<string, unknown>): void {
    const ev: BridgeEvent = {
      type: "tool.event",
      sessionId: this.#ctx.sessionId,
      payload: { event, data },
    };
    this.#ctx.emit(ev);
  }
}
