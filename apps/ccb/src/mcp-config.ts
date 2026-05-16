import { generateMcpConfig } from "@ccb/claude-code";

export interface McpConfigCliOptions {
  readonly sessionId: string;
  readonly endpoint: string;
  readonly out?: string;
}

const ENDPOINT_PATTERN = /^[^\s:]+:\d+$/;

export function isValidEndpoint(value: string): boolean {
  return ENDPOINT_PATTERN.test(value);
}

export async function runMcpConfig(opts: McpConfigCliOptions): Promise<string> {
  if (!isValidEndpoint(opts.endpoint)) {
    throw new Error(`invalid endpoint format: expected host:port, got ${opts.endpoint}`);
  }
  const cfg = generateMcpConfig({ sessionId: opts.sessionId, endpoint: opts.endpoint });
  const json = JSON.stringify(cfg, null, 2);
  if (opts.out) {
    await Bun.write(opts.out, json);
    return opts.out;
  }
  return json;
}
