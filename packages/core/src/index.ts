export {
  Bridge,
  type BridgeOptions,
  StartTimeoutError,
  type SupervisorFactory,
} from "./bridge.ts";
export { EventBus } from "./bus.ts";
export {
  CRASH_AGENT_DONE_REASON,
  CRASH_SESSION_ENDED_REASON,
  emitCrashEvents,
  synthesizeCrashEvents,
} from "./crash-events.ts";
export type { BridgeEvent } from "./events.ts";
export { JsonlEventStore } from "./store.ts";
export { dispatchBridgeTool, type Supervisor, type SupervisorContext } from "./supervisor.ts";
export type {
  ClaudeCodeBridge,
  EventsOptions,
  SendOptions,
  SessionHandle,
  StartSessionOptions,
} from "./types.ts";
