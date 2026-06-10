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
  close(sessionId: string): Promise<void>;
}
