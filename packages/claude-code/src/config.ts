export interface McpConfigOptions {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly enablePermissionRelay?: boolean;
}

export interface McpConfig {
  readonly mcpServers: {
    readonly ccb: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: {
        readonly CCB_BRIDGE_ENDPOINT: string;
        readonly CCB_SESSION_ID: string;
        readonly CCB_PERMISSION_RELAY?: "1";
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
          ...(opts.enablePermissionRelay ? { CCB_PERMISSION_RELAY: "1" as const } : {}),
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
   * Each component (command + args + event name) is shell-quoted with strict
   * single quotes, so paths with spaces, quotes, or shell metacharacters
   * (`$`, `;`, `&`, …) are safe.
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
  const hooks: Record<string, HooksSettingsMatcherEntry[]> = {};
  for (const event of opts.events) {
    const parts = [command, ...args, event].map(shellQuote);
    hooks[event] = [
      {
        hooks: [{ type: "command", command: parts.join(" ") }],
      },
    ];
  }
  return { hooks };
}

/**
 * Single-quote a POSIX shell argument. Closes the quote, escapes any embedded
 * single quotes as `'\''`, then re-opens. Safe for paths with spaces, quotes,
 * `$`, `;`, etc. Bare alphanumeric / safe-char strings are returned unquoted.
 */
function shellQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_\-./:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
