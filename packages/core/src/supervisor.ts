import type { BridgeEvent } from "./events.ts";

export interface SupervisorContext {
  readonly sessionId: string;
  emit(event: BridgeEvent): void;
}

export interface Supervisor {
  start(ctx: SupervisorContext): Promise<void>;
  sendMessage(sessionId: string, messageId: string, content: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
