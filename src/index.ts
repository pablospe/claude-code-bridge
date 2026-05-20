// Locked public surface for @pablospe/claude-code-bridge 0.1.0. Adding a symbol here is a
// minor bump; removing or renaming anything in this file is a major.

export {
  type ChannelsMode,
  type ClaudeCodeSupervisorOptions,
  claudeCodeSupervisorFactory,
  type HookEvent,
  mockSupervisorFactory,
} from "@ccb/claude-code";
export type {
  BridgeEvent,
  ClaudeCodeBridge,
  EventsOptions,
  SendOptions,
  SessionHandle,
  StartSessionOptions,
} from "@ccb/core";
export {
  Bridge,
  type BridgeOptions,
  CRASH_AGENT_DONE_REASON,
  CRASH_SESSION_ENDED_REASON,
  JsonlEventStore,
  StartTimeoutError,
} from "@ccb/core";
