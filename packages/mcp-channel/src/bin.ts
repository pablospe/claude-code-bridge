#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChannelServer } from "./channel-server.ts";
import { ControlClient } from "./control.ts";

async function main(): Promise<void> {
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

  // The channel server needs a reference to the control client to forward tool
  // calls. We construct the handle first with a placeholder onTool that defers
  // to the control client once it is created.
  let controlClient: ControlClient | undefined;
  const handle = createChannelServer({
    sessionId,
    onTool: async (name, args) => {
      if (!controlClient) throw new Error("ccb-channel-server: control client not initialized");
      await controlClient.sendTool(name, args);
    },
  });

  controlClient = new ControlClient({
    endpoint,
    sessionId,
    onDeliver: async (content, opts) => {
      await handle.deliver(content, opts);
    },
  });
  await controlClient.connect();

  const stdio = new StdioServerTransport();
  await handle.server.connect(stdio);

  const shutdown = async (): Promise<void> => {
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
    process.exit(0);
  };

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
