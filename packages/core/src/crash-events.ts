import type { BridgeEvent } from "./events.ts";
import type { SupervisorContext } from "./supervisor.ts";

/**
 * Reason marker on the synthesized agent.done event. Distinguishes a
 * supervisor-side channel disconnect from a normal agent-side completion.
 */
export const CRASH_AGENT_DONE_REASON = "channel-disconnected";

/**
 * Reason marker on the synthesized session.ended event. Distinguishes a
 * crash-driven termination from a normal Bridge.close().
 */
export const CRASH_SESSION_ENDED_REASON = "supervisor crashed";

/**
 * Reason marker on the session.ended event when a hosting bridge merely loses
 * its channel peer (a clean claude exit, for instance). The hosting side does
 * not own the claude process, so it cannot tell a crash from a normal exit;
 * "supervisor crashed" would be misleading here.
 */
export const CHANNEL_DISCONNECTED_SESSION_REASON = "channel disconnected";

/**
 * The agent.done + session.ended pair a supervisor should synthesize when it
 * loses its channel to the agent (peer socket close, control client
 * disconnect). The order matters: agent.done first so consumers see the
 * in-flight turn terminate, then session.ended so they know the session is
 * gone.
 */
export function synthesizeCrashEvents(sessionId: string): readonly BridgeEvent[] {
  return [
    { type: "agent.done", sessionId, reason: CRASH_AGENT_DONE_REASON },
    { type: "session.ended", sessionId, reason: CRASH_SESSION_ENDED_REASON },
  ];
}

/**
 * Emit the crash event pair through a supervisor context. Used by both the
 * MockSupervisor test seam and real supervisors whose channel went away.
 */
export function emitCrashEvents(ctx: SupervisorContext): void {
  for (const event of synthesizeCrashEvents(ctx.sessionId)) {
    ctx.emit(event);
  }
}

/**
 * The agent.done + session.ended pair a channel-hosting supervisor should
 * synthesize when its peer disconnects. Reuses the `channel-disconnected`
 * agent.done reason (accurate either way) but reports a neutral session.ended
 * reason rather than claiming a crash, since the hosting side cannot tell a
 * clean exit from a crash.
 */
export function synthesizeChannelDisconnectEvents(sessionId: string): readonly BridgeEvent[] {
  return [
    { type: "agent.done", sessionId, reason: CRASH_AGENT_DONE_REASON },
    { type: "session.ended", sessionId, reason: CHANNEL_DISCONNECTED_SESSION_REASON },
  ];
}

/**
 * Emit the channel-disconnect event pair through a supervisor context.
 */
export function emitChannelDisconnectEvents(ctx: SupervisorContext): void {
  for (const event of synthesizeChannelDisconnectEvents(ctx.sessionId)) {
    ctx.emit(event);
  }
}
