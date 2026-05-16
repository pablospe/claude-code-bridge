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

interface Session {
  readonly id: string;
  readonly bus: EventBus;
  readonly store: JsonlEventStore;
  readonly supervisor: Supervisor;
}

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
    const store = new JsonlEventStore(join(this.#storeDir, `${id}.jsonl`));
    const supervisor = this.#supervisorFactory(id);

    const session: Session = { id, bus, store, supervisor };
    this.#sessions.set(id, session);

    await supervisor.start({
      sessionId: id,
      emit: (event) => {
        this.#dispatch(session, event);
      },
    });

    await this.#dispatchAsync(session, { type: "session.started", sessionId: id });
    return { id };
  }

  async sendMessage(sessionId: string, content: string, _options?: SendOptions): Promise<string> {
    const session = this.#requireSession(sessionId);
    const messageId = crypto.randomUUID();
    await this.#dispatchAsync(session, {
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
      return emptyIterable();
    }
    return session.bus.subscribe();
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    await session.supervisor.interrupt(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    await this.#dispatchAsync(session, { type: "session.ended", sessionId });
    await session.supervisor.close(sessionId);
    session.bus.close();
    await session.store.close();
    this.#sessions.delete(sessionId);
  }

  /**
   * Read all events persisted for a session. Convenience for tests and tools
   * that need the full history without subscribing live.
   */
  async readStoredEvents(sessionId: string): Promise<BridgeEvent[]> {
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

  #dispatch(session: Session, event: BridgeEvent): void {
    session.bus.emit(event);
    // Fire-and-forget persistence for supervisor-emitted events. Errors are
    // surfaced as an unhandled rejection rather than swallowed silently.
    void session.store.append(event);
  }

  async #dispatchAsync(session: Session, event: BridgeEvent): Promise<void> {
    session.bus.emit(event);
    await session.store.append(event);
  }
}

function emptyIterable(): AsyncIterable<BridgeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<BridgeEvent> {
      return {
        next: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}
