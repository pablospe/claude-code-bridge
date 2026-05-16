import { generateMcpConfig } from "@ccb/claude-code";

export interface McpConfigCliOptions {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly out?: string;
}

export async function runMcpConfig(opts: McpConfigCliOptions): Promise<string> {
  const cfg = generateMcpConfig({ sessionId: opts.sessionId, endpoint: opts.endpoint });
  const json = JSON.stringify(cfg, null, 2);
  if (opts.out) {
    await Bun.write(opts.out, json);
    return opts.out;
  }
  return json;
}
