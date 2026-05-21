export {
  type ChannelsMode,
  ClaudeCodeSupervisor,
  type ClaudeCodeSupervisorOptions,
  claudeCodeSupervisorFactory,
  type LauncherFactory,
} from "./claude-supervisor.ts";
export {
  generateHooksSettings,
  generateMcpConfig,
  type HookEvent,
  type HooksSettings,
  type HooksSettingsHookEntry,
  type HooksSettingsMatcherEntry,
  type HooksSettingsOptions,
  type McpConfig,
  type McpConfigOptions,
} from "./config.ts";
export { MockSupervisor, mockSupervisorFactory } from "./mock-supervisor.ts";
export { type ChannelStatus, ServeSupervisor } from "./serve-supervisor.ts";
