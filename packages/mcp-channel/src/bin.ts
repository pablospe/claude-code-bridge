#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer } from "./channel-server.ts";
import { ControlClient } from "./control.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const connectTimeoutMs = Number(process.env.CCB_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const endpoint = process.env.CCB_BRIDGE_ENDPOINT;
  const sessionId = process.env.CCB_SESSION_ID;
  if (!endpoint) {
    console.error("ccb-channel-server: CCB_BRIDGE_ENDPOINT is required");
    process.exit(2);
  }
  if (!sessionId) {
    console.error("ccb-channel-server: CCB_SESSION_ID is required");
    process.exit(2);
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

  const shutdown = async (code = 0): Promise<void> => {
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
    process.exit(code);
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

  try {
    await Promise.race([
      controlClient.connect(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`connect timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    console.error(`ccb-channel-server: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  }

  const stdio = new StdioServerTransport();
  await handle.server.connect(stdio);

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err: unknown) => {
  console.error("ccb-channel-server: fatal error", err);
  process.exit(1);
});
