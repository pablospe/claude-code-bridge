export {
  Bridge,
  type BridgeOptions,
  StartTimeoutError,
  type SupervisorFactory,
} from "./bridge.ts";
export { EventBus } from "./bus.ts";
export {
  CHANNEL_DISCONNECTED_SESSION_REASON,
  CRASH_AGENT_DONE_REASON,
  CRASH_SESSION_ENDED_REASON,
  emitChannelDisconnectEvents,
  emitCrashEvents,
  synthesizeChannelDisconnectEvents,
  synthesizeCrashEvents,
} from "./crash-events.ts";
export type { BridgeEvent } from "./events.ts";
export {
  HookFanin,
  type HookFaninMetrics,
  type HookFaninOptions,
} from "./hook-fanin.ts";
export { HOOK_MAX_FIELD_BYTES, truncateHookPayload } from "./hooks.ts";
export { JsonlEventStore } from "./store.ts";
export {
  dispatchBridgeTool,
  type Supervisor,
  type SupervisorContext,
} from "./supervisor.ts";
export type {
  ClaudeCodeBridge,
  EventsOptions,
  SendOptions,
  SessionHandle,
  StartSessionOptions,
} from "./types.ts";
