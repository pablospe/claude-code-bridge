import type { BridgeEvent } from "./events.ts";

export interface SupervisorContext {
  readonly sessionId: string;
  emit(event: BridgeEvent): void;
}

export interface Supervisor {
  start(ctx: SupervisorContext): Promise<void>;
  sendMessage(sessionId: string, messageId: string, content: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /**
   * Reset the driven session's conversation context in place (e.g. inject
   * /clear into the interactive UI). Optional: supervisors that cannot reset
   * without a restart leave it undefined and Bridge.clear rejects.
   * Callers must ensure the session is idle (no outstanding turn); clearing
   * mid-turn races the reset against the active turn, and Bridge does not guard
   * against this.
   */
  clear?(sessionId: string): Promise<void>;
  /**
   * Answer an open permission request. Optional: only channels-capable
   * supervisors with the permission relay enabled implement it. Bridge.respond
   * rejects with "supervisor does not support respond" when undefined.
   */
  respond?(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void>;
  close(sessionId: string): Promise<void>;
}

/**
 * Translate a bridge tool call from the wire (bridge_reply / bridge_progress /
 * bridge_done) into a BridgeEvent and emit it through ctx. Shared between
 * supervisors that consume the same outbound MCP tool surface.
 *
 * Silently drops calls whose payload does not match the expected shape; the
 * channel-server schema layer already validates before the call gets here, so
 * mismatches at this layer indicate a non-bridge tool or wire corruption.
 */
export function dispatchBridgeTool(
  ctx: SupervisorContext,
  name: string,
  args: Record<string, unknown>,
): void {
  const sessionId = ctx.sessionId;
  if (name === "bridge_reply") {
    const content = args.content;
    const final = args.final;
    if (typeof content !== "string" || typeof final !== "boolean") return;
    const event: BridgeEvent = {
      type: "agent.reply",
      sessionId,
      content,
      final,
      ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
    };
    ctx.emit(event);
    return;
  }
  if (name === "bridge_progress") {
    const content = args.content;
    if (typeof content !== "string") return;
    const event: BridgeEvent = {
      type: "agent.progress",
      sessionId,
      content,
      ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
    };
    ctx.emit(event);
    return;
  }
  if (name === "bridge_done") {
    const event: BridgeEvent = {
      type: "agent.done",
      sessionId,
      ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    };
    ctx.emit(event);
    return;
  }
}
