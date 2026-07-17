#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer } from "./channel-server.ts";
import { ControlClient } from "./control.ts";
import { drainWritable } from "./drain.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_BUDGET_MS = 1_500;
const DRAIN_TIMEOUT_MS = 200;
// Settle window between claude's MCP `initialize` (observable via
// `oninitialized`) and claude actually registering its channel-notification
// handler (~tens of ms later, with no MCP signal). A channel notification
// delivered inside this window is dropped, not queued, so we hold `hello` —
// which gates the bridge's first delivery — for this long past `oninitialized`.
// Overridable via CCB_CHANNEL_READY_SETTLE_MS (0 disables, for tests).
const DEFAULT_CHANNEL_READY_SETTLE_MS = 500;

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
  const enablePermissionRelay = process.env.CCB_PERMISSION_RELAY === "1";
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
  // Resolves when claude completes the MCP `initialize` handshake. We gate the
  // bridge `hello` on this so the first channel notification is never delivered
  // before claude is ready to receive it (claude drops, rather than queues,
  // notifications that arrive mid-handshake).
  const initialized = Promise.withResolvers<void>();
  const handle = createChannelServer({
    sessionId,
    onInitialized: () => initialized.resolve(),
    onTool: async (name, args) => {
      if (!controlClient) throw new Error("control client not initialized");
      await controlClient.sendTool(name, args);
    },
    enablePermissionRelay,
    onPermissionRequest: async (req) => {
      if (!controlClient) throw new Error("control client not initialized");
      await controlClient.sendPermissionRequest(
        req.requestId,
        req.toolName,
        req.description,
        req.inputPreview,
      );
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
    onPermissionResponse: (requestId, behavior) => {
      void handle.respondPermission(requestId, behavior).catch((err: unknown) => {
        console.error(
          `ccb-channel-server: permission verdict send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  });

  // Install signal handlers IMMEDIATELY so an early Ctrl-C runs the bounded
  // shutdown path instead of stalling against the connect race.
  const onSignal = (): void => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Connect ordering matters — three steps, in sequence:
  //
  //   1. Attach the MCP stdio transport (handle.server.connect).
  //   2. Wait for claude's MCP `initialize` handshake to complete (the
  //      `initialized` promise, resolved from the server's `oninitialized`).
  //   3. Only then dial the bridge control connection, which sends `hello`.
  //
  // `hello` is what clears the bridge's supervisor.start gate and lets the
  // consumer deliver the first message. Each step guards a real race observed
  // against claude:
  //
  // - The transport must attach before `hello` so a deliver isn't dropped:
  //   the MCP SDK's Protocol uses `this._transport?.send()`, which silently
  //   no-ops with no transport attached.
  // - `hello` must wait for `initialized` because claude drops channel
  //   notifications that arrive before it finishes initializing — delivering
  //   at hello-time (pre-init) loses the message entirely.
  //
  // The bridge-side ControlServer.deliver hello-gate (default 30s) and the
  // connect timeout below bound the wait if claude never initializes.
  const stdio = new StdioServerTransport();
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const client = controlClient;
        if (!client) throw new Error("control client not initialized");
        await handle.server.connect(stdio);
        await initialized.promise;
        const rawSettle = Number(
          process.env.CCB_CHANNEL_READY_SETTLE_MS ?? DEFAULT_CHANNEL_READY_SETTLE_MS,
        );
        // Fall back to the default on a non-finite/negative override rather
        // than silently disabling the settle (Number("abc") -> NaN, NaN > 0 is
        // false), which would defeat the mid-init drop guard with no signal.
        const settleMs =
          Number.isFinite(rawSettle) && rawSettle >= 0
            ? rawSettle
            : DEFAULT_CHANNEL_READY_SETTLE_MS;
        if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
        await client.connect();
      })(),
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
}

main().catch(async (err: unknown) => {
  console.error("ccb-channel-server: fatal error", err);
  process.exitCode = 1;
  await drainStdout();
  process.exit();
});
