import type { Supervisor, SupervisorContext } from "@ccb/core";

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
      readonly args: string[];
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

export class ClaudeCodeSupervisor implements Supervisor {
  async start(_ctx: SupervisorContext): Promise<never> {
    throw new Error("managed launch is not implemented");
  }

  async sendMessage(_sessionId: string, _messageId: string, _content: string): Promise<void> {
    throw new Error("managed launch is not implemented");
  }

  async interrupt(_sessionId: string): Promise<void> {
    throw new Error("managed launch is not implemented");
  }

  async close(_sessionId: string): Promise<void> {
    // no-op so Bridge teardown does not throw on a never-started supervisor
  }
}
