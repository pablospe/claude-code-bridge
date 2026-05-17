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
