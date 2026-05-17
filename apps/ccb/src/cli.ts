#!/usr/bin/env bun
import {
  type ChannelsMode,
  claudeCodeSupervisorFactory,
  mockSupervisorFactory,
} from "@ccb/claude-code";
import type { SupervisorFactory } from "@ccb/core";
import { Command, InvalidArgumentError } from "commander";
import { type DemoFormat, runDemo } from "./demo.ts";
import { formatJson, formatPretty } from "./format.ts";
import { isValidEndpoint, runMcpConfig } from "./mcp-config.ts";
import { runServe, type ServeFormat } from "./serve.ts";

const VERSION = "0.0.1";

export type SupervisorChoice = "mock" | "claude";

export interface SupervisorSelection {
  readonly supervisor: SupervisorChoice;
  readonly channels: ChannelsMode;
}

/**
 * Build the supervisor factory the demo subcommand will hand to Bridge. The
 * `channels` selection is consulted only for the `claude` supervisor; for
 * `mock` it is accepted and ignored so the flag stays forward-compatible.
 */
export function selectSupervisorFactory(sel: SupervisorSelection): SupervisorFactory {
  if (sel.supervisor === "claude") {
    return claudeCodeSupervisorFactory({ channels: sel.channels });
  }
  return mockSupervisorFactory();
}

interface DemoCommandOptions {
  readonly format: DemoFormat;
  readonly storeDir: string;
  readonly timeoutMs: number;
  readonly supervisor: SupervisorChoice;
  readonly channels: ChannelsMode;
}

interface McpConfigCommandOptions {
  readonly sessionId?: string;
  readonly endpoint: string;
  readonly out?: string;
}

interface ServeCommandOptions {
  readonly endpoint: string;
  readonly sessionId?: string;
  readonly storeDir: string;
  readonly format: ServeFormat;
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

function parseServeFormat(value: string): ServeFormat {
  if (value === "json" || value === "pretty") return value;
  throw new InvalidArgumentError("must be one of: json, pretty");
}

function parseEndpointOption(value: string): string {
  if (!isValidEndpoint(value)) {
    throw new InvalidArgumentError("invalid endpoint format: expected host:port");
  }
  return value;
}

function parseSupervisorChoice(value: string): SupervisorChoice {
  if (value === "mock" || value === "claude") return value;
  throw new InvalidArgumentError("--supervisor must be one of: mock, claude");
}

function parseChannelsMode(value: string): ChannelsMode {
  if (value === "dev-flag" || value === "plugin") return value;
  throw new InvalidArgumentError("--channels must be one of: dev-flag, plugin");
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ccb")
    .description("Claude Code Bridge developer CLI")
    .version(VERSION, "-V, --version", "print the CLI version");

  program
    .command("demo")
    .description("run an end-to-end demo turn against a mock or real claude supervisor")
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
    .option(
      "--supervisor <mock|claude>",
      "supervisor to drive the bridge: mock (default) or claude (managed launch)",
      parseSupervisorChoice,
      "mock" as SupervisorChoice,
    )
    .option(
      "--channels <dev-flag|plugin>",
      "channel registration mode for --supervisor=claude (ignored for mock)",
      parseChannelsMode,
      "dev-flag" as ChannelsMode,
    )
    .action(async (input: string, opts: DemoCommandOptions) => {
      const isStream = opts.format === "stream";
      const supervisorFactory = selectSupervisorFactory({
        supervisor: opts.supervisor,
        channels: opts.channels,
      });
      const result = await runDemo({
        input,
        supervisorFactory,
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

  program
    .command("serve")
    .description("host the bridge control endpoint for a manual real-claude smoke session")
    .requiredOption(
      "--endpoint <host:port>",
      "host:port to bind the bridge control endpoint",
      parseEndpointOption,
    )
    .option("--session-id <id>", "session id to use (defaults to a random UUID)")
    .option("--store-dir <path>", "directory for per-session JSONL logs", ".ccb-data")
    .option(
      "--format <json|pretty>",
      "output format for the live event stream",
      parseServeFormat,
      "pretty" as ServeFormat,
    )
    .action(async (opts: ServeCommandOptions) => {
      const sessionId = opts.sessionId ?? crypto.randomUUID();
      await runServe({
        endpoint: opts.endpoint,
        sessionId,
        storeDir: opts.storeDir,
        format: opts.format,
      });
    });

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
