#!/usr/bin/env bun
// Throwaway stdio MCP server for the permission-relay spike (Task 1 of M5).
// Declares the `claude/channel` + `claude/channel/permission` experimental
// capabilities, logs every permission_request notification it receives, and
// auto-replies "allow". A fallbackNotificationHandler captures the RAW shape
// of any `notifications/claude/*` notification so we can see the true wire
// schema even if the documented zod schema rejects.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const LOG = process.env.CCB_SPIKE_LOG;
if (!LOG) throw new Error("CCB_SPIKE_LOG is required");
const log = (entry: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

const server = new Server(
  { name: "ccb-spike", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
    },
  },
);

const PermissionRequestNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

server.setNotificationHandler(PermissionRequestNotificationSchema, async (n) => {
  log({ kind: "permission_request", ...n.params });
  await server.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id: n.params.request_id, behavior: "allow" },
  });
  log({ kind: "verdict_sent", request_id: n.params.request_id, behavior: "allow" });
});

// Capture the true shape of any claude channel notification, regardless of
// whether the documented schema above matched. If the documented schema is
// wrong, zod rejects before the typed handler fires and this is the only
// record of the real params.
server.fallbackNotificationHandler = async (notification): Promise<void> => {
  const method = notification.method;
  if (typeof method === "string" && method.startsWith("notifications/claude/")) {
    log({
      kind: "raw_notification",
      method,
      params: (notification as { params?: unknown }).params,
    });
    // If this is a permission request the typed handler missed (schema drift),
    // still try to unblock it so phase A can succeed. Best-effort: only when a
    // request_id is observable in the raw params.
    if (method === "notifications/claude/channel/permission_request") {
      const params = (notification as { params?: Record<string, unknown> }).params;
      const requestId = params?.request_id ?? params?.requestId;
      if (typeof requestId === "string") {
        await server.notification({
          method: "notifications/claude/channel/permission",
          params: { request_id: requestId, behavior: "allow" },
        });
        log({ kind: "verdict_sent_fallback", request_id: requestId, behavior: "allow" });
      }
    }
  }
};

server.oninitialized = () => log({ kind: "initialized" });
await server.connect(new StdioServerTransport());
log({ kind: "connected" });
