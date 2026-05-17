#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer } from "./channel-server.ts";
import { ControlClient } from "./control.ts";
import { drainWritable } from "./drain.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_BUDGET_MS = 1_500;
const DRAIN_TIMEOUT_MS = 200;

async function drainStdout(): Promise<void> {
  // The MCP transport writes JSON-RPC frames to stdout. A bare process.exit
  // can truncate the last frame before claude reads it. Wait for the empty
  // write callback so the kernel has flushed. Bounded by DRAIN_TIMEOUT_MS so
  // an orphaned or wedged stdout cannot defeat SHUTDOWN_BUDGET_MS.
  await drainWritable(process.stdout, DRAIN_TIMEOUT_MS);
}

async function main(): Promise<void> {
  const connectTimeoutMs = Number(process.env.CCB_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS);
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) {
    console.error(
      `ccb-channel-server: CCB_CONNECT_TIMEOUT_MS must be a positive number (got ${process.env.CCB_CONNECT_TIMEOUT_MS})`,
    );
    process.exitCode = 2;
    await drainStdout();
    process.exit();
  }
  const endpoint = process.env.CCB_BRIDGE_ENDPOINT;
  const sessionId = process.env.CCB_SESSION_ID;
  if (!endpoint) {
    console.error("ccb-channel-server: CCB_BRIDGE_ENDPOINT is required");
    process.exitCode = 2;
    await drainStdout();
    process.exit();
  }
  if (!sessionId) {
    console.error("ccb-channel-server: CCB_SESSION_ID is required");
    process.exitCode = 2;
    await drainStdout();
    process.exit();
  }

  // controlClient is wired after handle so onTool can reference it.
  let controlClient: ControlClient | undefined;
  const handle = createChannelServer({
    sessionId,
    onTool: async (name, args) => {
      if (!controlClient) throw new Error("control client not initialized");
      await controlClient.sendTool(name, args);
    },
  });

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const budget = setTimeout(() => {
      // Hard-stop if cooperative shutdown stalls beyond the budget so claude
      // does not hang on a wedged channel server.
      process.exitCode = code;
      process.exit();
    }, SHUTDOWN_BUDGET_MS);
    budget.unref?.();
    try {
      await handle.server.close();
    } catch {
      // best effort
    }
    try {
      await controlClient?.close();
    } catch {
      // best effort
    }
    process.exitCode = code;
    // Leave the budget timer armed; it is unref'd so it won't block exit on
    // the happy path. Clearing it before drainStdout would let a wedged
    // stdout defeat the hard-stop.
    await drainStdout();
    process.exit();
  };

  controlClient = new ControlClient({
    endpoint,
    sessionId,
    onDeliver: async (content, opts) => {
      await handle.deliver(content, opts);
    },
    onConnectionLost: (err) => {
      console.error(`ccb-channel-server: control connection lost: ${err?.message ?? "closed"}`);
      void shutdown(4);
    },
  });

  // Install signal handlers IMMEDIATELY so an early Ctrl-C runs the bounded
  // shutdown path instead of stalling against the connect race.
  const onSignal = (): void => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      controlClient.connect(),
      new Promise<never>((_resolve, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error(`connect timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        );
        connectTimer.unref?.();
      }),
    ]);
  } catch (err) {
    if (connectTimer) clearTimeout(connectTimer);
    console.error(`ccb-channel-server: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 3;
    await drainStdout();
    process.exit();
  }
  if (connectTimer) clearTimeout(connectTimer);

  const stdio = new StdioServerTransport();
  await handle.server.connect(stdio);
}

main().catch(async (err: unknown) => {
  console.error("ccb-channel-server: fatal error", err);
  process.exitCode = 1;
  await drainStdout();
  process.exit();
});
