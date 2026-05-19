export interface McpConfigOptions {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface McpConfig {
  readonly mcpServers: {
    readonly ccb: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: {
        readonly CCB_BRIDGE_ENDPOINT: string;
        readonly CCB_SESSION_ID: string;
      };
    };
  };
}

const DEFAULT_COMMAND = "bunx";
const DEFAULT_ARGS: readonly string[] = ["ccb-channel-server"];

export function generateMcpConfig(opts: McpConfigOptions): McpConfig {
  const command = opts.command ?? DEFAULT_COMMAND;
  const args = [...(opts.args ?? DEFAULT_ARGS)];
  return {
    mcpServers: {
      ccb: {
        command,
        args,
        env: {
          CCB_BRIDGE_ENDPOINT: opts.endpoint,
          CCB_SESSION_ID: opts.sessionId,
        },
      },
    },
  };
}

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";

export interface HooksSettingsOptions {
  readonly events: ReadonlyArray<HookEvent>;
  /**
   * Executable that runs the relay. Default `"bunx"` so the generated snippet
   * works after `bun install` without knowing the relay file path locally.
   *
   * Callers passing args containing spaces are on their own: the snippet is a
   * shell command string and this function does not quote arguments.
   */
  readonly command?: string;
  /** Args prefixed before the event name. Default `["ccb-hook-relay"]`. */
  readonly args?: ReadonlyArray<string>;
}

export interface HooksSettingsHookEntry {
  readonly type: "command";
  readonly command: string;
}

export interface HooksSettingsMatcherEntry {
  readonly hooks: ReadonlyArray<HooksSettingsHookEntry>;
}

export interface HooksSettings {
  readonly hooks: Record<string, ReadonlyArray<HooksSettingsMatcherEntry>>;
}

const DEFAULT_HOOK_COMMAND = "bunx";
const DEFAULT_HOOK_ARGS: readonly string[] = ["ccb-hook-relay"];

export function generateHooksSettings(opts: HooksSettingsOptions): HooksSettings {
  if (!Array.isArray(opts.events) || opts.events.length === 0) {
    throw new Error("hooks.events must be a non-empty array");
  }
  const command = opts.command ?? DEFAULT_HOOK_COMMAND;
  const args = opts.args ?? DEFAULT_HOOK_ARGS;
  const prefix = [command, ...args].join(" ");
  const hooks: Record<string, HooksSettingsMatcherEntry[]> = {};
  for (const event of opts.events) {
    hooks[event] = [
      {
        hooks: [{ type: "command", command: `${prefix} ${event}` }],
      },
    ];
  }
  return { hooks };
}
