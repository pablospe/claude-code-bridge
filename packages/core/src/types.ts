import type { BridgeEvent } from "./events.ts";

export type StartSessionOptions = Record<string, never>;

export type SendOptions = Record<string, never>;

export interface EventsOptions {
  /**
   * Reserved for replay-from-cursor support backed by the JSONL store.
   * Currently ignored; events(sessionId) is a live tail from subscribe-time forward.
   */
  since?: number;
}

export interface SessionHandle {
  readonly id: string;
}

export interface ClaudeCodeBridge {
  startSession(options: StartSessionOptions): Promise<SessionHandle>;
  sendMessage(sessionId: string, content: string, options?: SendOptions): Promise<string>;
  events(sessionId: string, options?: EventsOptions): AsyncIterable<BridgeEvent>;
  interrupt(sessionId: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
  /**
   * Answer an open permission.requested. Exactly-once (the registry entry and
   * timer are cleared synchronously before any await); persist-before-send (the
   * permission.resolved record is durably appended before the verdict crosses
   * the wire, and a store failure means no verdict is sent). Rejects for unknown
   * ids ("no open permission request"), non-open sessions ("session is
   * closing"), and supervisors without respond ("supervisor does not support
   * respond").
   */
  respond(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: { approver?: { userId: string; displayName?: string } },
  ): Promise<void>;
  close(sessionId: string): Promise<void>;
}
