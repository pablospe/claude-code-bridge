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

export interface BridgeOptions {
  /** Directory where per-session JSONL logs are written. */
  storeDir: string;
  /** Factory invoked once per startSession to build the session supervisor. */
  supervisorFactory: SupervisorFactory;
}

type SessionState = "starting" | "open" | "closing" | "closed";

interface Session {
  readonly id: string;
  readonly bus: EventBus;
  readonly store: JsonlEventStore;
  readonly supervisor: Supervisor;
  state: SessionState;
  /** Fire-and-forget append promises emitted from the supervisor path. */
  readonly pending: Set<Promise<void>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bridge facade implementing the ClaudeCodeBridge API.
 *
 * SessionManager state is kept inline as a private Map<sessionId, Session>
 * because there is no second consumer of it. Spinning it out into a separate
 * class would be speculative.
 *
 * events(sessionId) is a live tail from subscribe-time forward in M1. The
 * EventsOptions.since field is reserved for future replay-from-cursor support
 * and is currently ignored.
 */
export class Bridge implements ClaudeCodeBridge {
  readonly #sessions = new Map<string, Session>();
  readonly #storeDir: string;
  readonly #supervisorFactory: SupervisorFactory;

  constructor(options: BridgeOptions) {
    this.#storeDir = options.storeDir;
    this.#supervisorFactory = options.supervisorFactory;
  }

  async startSession(_options: StartSessionOptions): Promise<SessionHandle> {
    const id = crypto.randomUUID();
    const bus = new EventBus();
    const storePath = join(this.#storeDir, `${id}.jsonl`);
    const store = new JsonlEventStore(storePath);
    const supervisor = this.#supervisorFactory(id);

    const session: Session = {
      id,
      bus,
      store,
      supervisor,
      state: "starting",
      pending: new Set(),
    };
    this.#sessions.set(id, session);

    try {
      // Persist session.started before any supervisor-emitted event so the
      // store/bus ordering is "session.started leads."
      await this.#emitAwaited(session, { type: "session.started", sessionId: id });
      await supervisor.start({
        sessionId: id,
        emit: (event) => {
          this.#emitFromSupervisor(session, event);
        },
      });
      session.state = "open";
    } catch (err) {
      // Best-effort teardown of the partially-built session. Remove the
      // half-written JSONL file so a failed start does not leak state.
      this.#sessions.delete(id);
      session.state = "closed";
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

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (session.state === "closing" || session.state === "closed") return;
    session.state = "closing";
    let inner: unknown;
    try {
      await this.#emitAwaited(session, { type: "session.ended", sessionId });
      await session.supervisor.close(sessionId);
    } catch (err) {
      inner = err;
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
   * that need the full history without subscribing live.
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
    session.bus.emit(event);
    const p = session.store.append(event);
    session.pending.add(p);
    p.catch((err) => {
      console.error(`Bridge: failed to persist event for session ${session.id}: ${String(err)}`);
    }).finally(() => {
      session.pending.delete(p);
    });
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
