#!/usr/bin/env bun
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Command, InvalidArgumentError } from "commander";
import { type DemoFormat, runDemo } from "./demo.ts";
import { formatJson, formatPretty } from "./format.ts";
import { isValidEndpoint, runMcpConfig } from "./mcp-config.ts";

const VERSION = "0.0.1";

interface DemoCommandOptions {
  readonly format: DemoFormat;
  readonly storeDir: string;
  readonly timeoutMs: number;
}

interface McpConfigCommandOptions {
  readonly sessionId?: string;
  readonly endpoint: string;
  readonly out?: string;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return n;
}

function parseFormat(value: string): DemoFormat {
  if (value === "json" || value === "pretty" || value === "stream") return value;
  throw new InvalidArgumentError("must be one of: json, pretty, stream");
}

function parseEndpointOption(value: string): string {
  if (!isValidEndpoint(value)) {
    throw new InvalidArgumentError("invalid endpoint format: expected host:port");
  }
  return value;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ccb")
    .description("Claude Code Bridge developer CLI")
    .version(VERSION, "-V, --version", "print the CLI version");

  program
    .command("demo")
    .description("run an end-to-end demo turn using the MockSupervisor")
    .argument("<input>", "message to send to the agent")
    .option(
      "--format <json|pretty|stream>",
      "output format: json (one event per line), pretty (human-readable), stream (live json)",
      parseFormat,
      "pretty" as DemoFormat,
    )
    .option("--store-dir <path>", "directory for per-session JSONL logs", ".ccb-data")
    .option(
      "--timeout-ms <ms>",
      "abort the demo if it does not complete within this many milliseconds",
      parsePositiveInt,
      10_000,
    )
    .action(async (input: string, opts: DemoCommandOptions) => {
      const isStream = opts.format === "stream";
      const result = await runDemo({
        input,
        supervisorFactory: mockSupervisorFactory(),
        format: opts.format,
        storeDir: opts.storeDir,
        timeoutMs: opts.timeoutMs,
        onEvent: isStream ? (_ev, line) => process.stdout.write(`${line}\n`) : undefined,
      });
      if (!isStream) {
        const formatter = opts.format === "pretty" ? formatPretty : formatJson;
        for (const ev of result.events) {
          process.stdout.write(`${formatter(ev)}\n`);
        }
      }
    });

  // TODO(real-claude smoke): add `ccb serve --endpoint <host:port> --session-id <id>` using ControlServer from @ccb/mcp-channel; print events as JSON on stdout, "listening on host:port" on stderr, and drive bridge.close on SIGINT/SIGTERM.
  program
    .command("mcp-config")
    .description("emit the .mcp.json shape Claude Code expects via --mcp-config")
    .option("--session-id <id>", "session id to embed in the config (defaults to a random UUID)")
    .requiredOption(
      "--endpoint <host:port>",
      "bridge control endpoint the channel server connects to",
      parseEndpointOption,
    )
    .option("--out <path>", "write the JSON to this path instead of stdout")
    .action(async (opts: McpConfigCommandOptions) => {
      const sessionId = opts.sessionId ?? crypto.randomUUID();
      const output = await runMcpConfig({
        sessionId,
        endpoint: opts.endpoint,
        out: opts.out,
      });
      process.stdout.write(`${output}\n`);
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ccb: ${message}\n`);
    process.exit(1);
  });
}
