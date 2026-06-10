import { rm } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "./bus.ts";
import type { BridgeEvent } from "./events.ts";
import { JsonlEventStore } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";
import type {
  ClaudeCodeBridge,
  EventsOptions,
  SendOptions,
  SessionHandle,
  StartSessionOptions,
} from "./types.ts";

/**
 * Builds a Supervisor for a new session. Called once per startSession() so
 * each session owns its own supervisor instance.
 */
export type SupervisorFactory = (sessionId: string) => Supervisor;

/** Minimal store contract used by Bridge. Matches JsonlEventStore. */
export interface BridgeEventStore {
  append(event: BridgeEvent): Promise<void>;
  readAll(): Promise<BridgeEvent[]>;
  close(): Promise<void>;
}

/**
 * Builds a store for a new session. Test-only seam; defaults to JsonlEventStore.
 */
export type StoreFactory = (sessionId: string, path: string) => BridgeEventStore;

export interface BridgeOptions {
  /** Directory where per-session JSONL logs are written. */
  storeDir: string;
  /** Factory invoked once per startSession to build the session supervisor. */
  supervisorFactory: SupervisorFactory;
  /**
   * Optional factory for the per-session event store. Defaults to building a
   * JsonlEventStore at `${storeDir}/${sessionId}.jsonl`. Exists primarily so
   * tests can inject failure modes.
   */
  storeFactory?: StoreFactory;
  /**
   * Upper bound for awaiting supervisor.close during Bridge.close. On timeout
   * the bridge logs and still runs the finally teardown so the session is
   * removed from the map and the bus/store closed. Defaults to 5000ms.
   */
  closeTimeoutMs?: number;
  /**
   * Upper bound for awaiting supervisor.start during Bridge.startSession. On
   * timeout the bridge throws StartTimeoutError and runs the same failed-start
   * cleanup path as a supervisor.start that rejects naturally (delete the
   * session entry, drain pending appends, close the bus, close the store,
   * remove the half-written JSONL file). The bound applies to supervisor.start
   * only; subsequent supervisor calls are not affected. Defaults to 30000ms.
   */
  startTimeoutMs?: number;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const STORE_ERROR_THRESHOLD = 3;

type SessionState = "starting" | "open" | "closing" | "closed";

interface Session {
  readonly id: string;
  readonly bus: EventBus;
  readonly store: BridgeEventStore;
  readonly supervisor: Supervisor;
  state: SessionState;
  /** Fire-and-forget append promises emitted from the supervisor path. */
  readonly pending: Set<Promise<void>>;
  /** Shared promise for an in-flight close so concurrent callers await it. */
  closingPromise?: Promise<void>;
  /** Consecutive store.append failures; resets to 0 on the next success. */
  storeErrorCount: number;
  /** Once an agent.done store-error notice has fired, do not repeat it. */
  storeErrorNotified: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bridge facade implementing the ClaudeCodeBridge API.
 *
 * SessionManager state is kept inline as a private Map<sessionId, Session>
 * because there is no second consumer of it. Spinning it out into a separate
 * class would be speculative.
 *
 * events(sessionId) is a live tail from subscribe-time forward. The
 * EventsOptions.since field is reserved for future replay-from-cursor support
 * and is currently ignored.
 */
export class Bridge implements ClaudeCodeBridge {
  readonly #sessions = new Map<string, Session>();
  readonly #storeDir: string;
  readonly #supervisorFactory: SupervisorFactory;
  readonly #storeFactory: StoreFactory;
  readonly #closeTimeoutMs: number;
  readonly #startTimeoutMs: number;

  constructor(options: BridgeOptions) {
    this.#storeDir = options.storeDir;
    this.#supervisorFactory = options.supervisorFactory;
    this.#storeFactory = options.storeFactory ?? ((_id, path) => new JsonlEventStore(path));
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    // Timeouts must be positive integers. A value of 0 fires the timer before
    // supervisor.start reaches its first await, letting it leak half-built
    // resources; fractional values quietly round inside setTimeout. Reject
    // both at the constructor boundary rather than silently coercing.
    assertPositiveInteger(this.#startTimeoutMs, "startTimeoutMs");
    assertPositiveInteger(this.#closeTimeoutMs, "closeTimeoutMs");
  }

  async startSession(_options: StartSessionOptions): Promise<SessionHandle> {
    const id = crypto.randomUUID();
    const bus = new EventBus();
    const storePath = join(this.#storeDir, `${id}.jsonl`);
    const store = this.#storeFactory(id, storePath);
    const supervisor = this.#supervisorFactory(id);

    const session: Session = {
      id,
      bus,
      store,
      supervisor,
      state: "starting",
      pending: new Set(),
      storeErrorCount: 0,
      storeErrorNotified: false,
    };
    this.#sessions.set(id, session);

    try {
      // Persist session.started before any supervisor-emitted event so the
      // store/bus ordering is "session.started leads."
      await this.#emitAwaited(session, { type: "session.started", sessionId: id });
      await raceWithTimeout(
        supervisor.start({
          sessionId: id,
          emit: (event) => {
            this.#emitFromSupervisor(session, event);
          },
        }),
        this.#startTimeoutMs,
        "supervisor.start",
        (label, ms) => new StartTimeoutError(label, ms),
      );
      session.state = "open";
    } catch (err) {
      // Best-effort teardown of the partially-built session. Remove the
      // half-written JSONL file so a failed start does not leak state.
      this.#sessions.delete(id);
      session.state = "closed";
      // Release any resources the supervisor allocated before its start
      // rejected (or before the start timeout fired). Bounded by closeTimeoutMs
      // so a wedged close cannot replace a wedged start.
      await raceWithTimeout(
        supervisor.close(id),
        this.#closeTimeoutMs,
        "supervisor.close",
        (label, ms) => new CloseTimeoutError(label, ms),
      ).catch(() => undefined);
      // Drain any supervisor-emitted appends that happened before the throw
      // so store.close doesn't race with in-flight writes.
      if (session.pending.size > 0) {
        await Promise.allSettled([...session.pending]);
      }
      bus.close();
      await store.close().catch(() => undefined);
      await rm(storePath, { force: true }).catch(() => undefined);
      throw err;
    }

    return { id };
  }

  async sendMessage(sessionId: string, content: string, _options?: SendOptions): Promise<string> {
    const session = this.#requireSession(sessionId);
    if (session.state !== "open") {
      throw new Error(`session is closing: ${sessionId}`);
    }
    const messageId = crypto.randomUUID();
    await this.#emitAwaited(session, {
      type: "message.sent",
      sessionId,
      messageId,
      content,
    });
    await session.supervisor.sendMessage(sessionId, messageId, content);
    return messageId;
  }

  events(sessionId: string, _options?: EventsOptions): AsyncIterable<BridgeEvent> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      // Empty iterable: a closed EventBus produces a subscriber that ends
      // immediately, so consumers get a clean for-await with no events.
      const emptyBus = new EventBus();
      emptyBus.close();
      return emptyBus.subscribe();
    }
    return session.bus.subscribe();
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    if (session.state !== "open") {
      throw new Error(`session is closing: ${sessionId}`);
    }
    await session.supervisor.interrupt(sessionId);
  }

  async clear(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    if (session.state !== "open") {
      throw new Error(`session is closing: ${sessionId}`);
    }
    if (session.supervisor.clear === undefined) {
      throw new Error("supervisor does not support clear");
    }
    await session.supervisor.clear(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    // Concurrent close: share the same in-flight teardown so callers
    // observe the real completion, not a false-positive resolve.
    if (session.closingPromise) return session.closingPromise;
    if (session.state === "closed") return;
    session.state = "closing";
    // closingPromise must be set BEFORE #runClose begins executing so that a
    // synchronous re-entrant bridge.close (e.g. driven by supervisor.close
    // calling back into the bridge) observes the in-flight promise and
    // dedups instead of starting a second teardown pass.
    const deferred = createDeferred<void>();
    session.closingPromise = deferred.promise;
    this.#runClose(session, { emitSessionEnded: true }).then(deferred.resolve, deferred.reject);
    return session.closingPromise;
  }

  async #runClose(session: Session, options: { emitSessionEnded: boolean }): Promise<void> {
    const sessionId = session.id;
    let inner: unknown;
    try {
      // Persist session.ended and tear down the supervisor independently:
      // a persistence failure must NOT short-circuit supervisor.close(),
      // otherwise resources leak. Preserve the first error.
      if (options.emitSessionEnded) {
        try {
          await this.#emitAwaited(session, { type: "session.ended", sessionId });
        } catch (err) {
          inner = err;
        }
      }
      try {
        await raceWithTimeout(
          session.supervisor.close(sessionId),
          this.#closeTimeoutMs,
          "supervisor.close",
          (label, ms) => new CloseTimeoutError(label, ms),
        );
      } catch (err) {
        if (err instanceof CloseTimeoutError) {
          console.error(`Bridge: ${err.message} for session ${sessionId}`);
        } else if (inner === undefined) {
          inner = err;
        }
      }
    } finally {
      // Drain in-flight supervisor-emitted appends before closing the store.
      if (session.pending.size > 0) {
        await Promise.allSettled([...session.pending]);
      }
      session.bus.close();
      await session.store.close().catch(() => undefined);
      session.state = "closed";
      this.#sessions.delete(sessionId);
    }
    if (inner !== undefined) {
      throw inner;
    }
  }

  /**
   * Read all events persisted for a session. Convenience for tests and tools
   * that need the full history without subscribing live. Active-session reads
   * may not include the most recent in-flight supervisor-emitted events.
   */
  async readStoredEvents(sessionId: string): Promise<BridgeEvent[]> {
    if (!UUID_RE.test(sessionId)) {
      throw new Error("invalid sessionId");
    }
    const session = this.#sessions.get(sessionId);
    const store = session?.store ?? new JsonlEventStore(join(this.#storeDir, `${sessionId}.jsonl`));
    return store.readAll();
  }

  #requireSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    return session;
  }

  /**
   * Fire-and-forget emit path for events the supervisor pushes. The bus emit
   * is synchronous; the store append is tracked in session.pending so close()
   * can drain it. Drops events once the session is closing/closed.
   *
   * A supervisor-emitted session.ended is a terminal signal (e.g. channel
   * disconnect): the event is emitted/persisted, then the bridge transitions
   * the session into closing and runs the rest of the teardown ladder without
   * emitting a second session.ended. Subsequent sendMessage/interrupt reject
   * with the same "closing" error as a user-initiated close.
   */
  #emitFromSupervisor(session: Session, event: BridgeEvent): void {
    if (event.sessionId !== session.id) {
      console.error(
        `Bridge: dropping supervisor event with wrong sessionId (expected ${session.id}, got ${event.sessionId})`,
      );
      return;
    }
    if (session.state === "closing" || session.state === "closed") {
      return;
    }
    const isTerminalEnd = event.type === "session.ended";
    if (isTerminalEnd) {
      // Flip state synchronously so a sendMessage racing with the append
      // observes "closing" and rejects rather than queuing into a dying bus.
      session.state = "closing";
    }
    session.bus.emit(event);
    const p = session.store.append(event);
    session.pending.add(p);
    p.then(
      () => {
        // A successful append re-arms the latch so a future burst of failures
        // can escalate again.
        session.storeErrorCount = 0;
        session.storeErrorNotified = false;
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Bridge: failed to persist event for session ${session.id}: ${msg}`);
        // Count consecutive failures regardless of message. A run of mixed
        // errors (EIO -> ENOSPC -> EIO) still escalates at the threshold.
        session.storeErrorCount += 1;
        if (
          session.storeErrorCount >= STORE_ERROR_THRESHOLD &&
          !session.storeErrorNotified &&
          session.state !== "closing" &&
          session.state !== "closed"
        ) {
          session.storeErrorNotified = true;
          session.bus.emit({
            type: "agent.done",
            sessionId: session.id,
            reason: "store-error",
          });
        }
      },
    ).finally(() => {
      session.pending.delete(p);
    });
    if (isTerminalEnd) {
      // The supervisor signalled end-of-session. State is already "closing"
      // (set above); now run the teardown ladder so the bus closes (live
      // iterators terminate cleanly) and supervisor.close runs once.
      // emitSessionEnded:false because the supervisor's own event is already
      // in flight on session.pending and will be drained inside #runClose.
      //
      // closingPromise MUST be assigned BEFORE #runClose begins executing.
      // #runClose calls session.supervisor.close synchronously up to its
      // first await; if that supervisor.close re-enters bridge.close (e.g.
      // a fan-out teardown handler), the re-entrant call must observe
      // closingPromise to dedup. Bridge a Deferred to wire the work in.
      const deferred = createDeferred<void>();
      session.closingPromise = deferred.promise;
      this.#runClose(session, { emitSessionEnded: false }).then(deferred.resolve, deferred.reject);
      // Detach from the unhandled-rejection path; callers who care await it
      // via bridge.close(sessionId).
      session.closingPromise.catch((err) => {
        console.error(`Bridge: supervisor-initiated close failed: ${String(err)}`);
      });
    }
  }

  /**
   * Bridge-initiated emit path. Awaits persistence so the caller can sequence
   * subsequent work after the event is durable.
   */
  async #emitAwaited(session: Session, event: BridgeEvent): Promise<void> {
    session.bus.emit(event);
    await session.store.append(event);
  }
}

class CloseTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "CloseTimeoutError";
  }
}

export class StartTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "StartTimeoutError";
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer; got ${value}`);
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  makeError: (label: string, timeoutMs: number) => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(makeError(label, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
  // Attach a swallowing handler to the in-flight promise BEFORE racing so a
  // late rejection from the loser does not surface as an unhandledRejection
  // once the race has settled in favor of the timeout.
  const guarded = promise.then(
    (value) => {
      if (!settled) {
        settled = true;
      }
      return value;
    },
    (err) => {
      if (settled) {
        // Race already lost; swallow late rejection.
        return undefined as unknown as T;
      }
      settled = true;
      throw err;
    },
  );
  return Promise.race([guarded, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
