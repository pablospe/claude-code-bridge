import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { createChannelServer } from "./channel-server.ts";

const ChannelNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/claude/channel"),
  params: z.looseObject({
    content: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

async function until(
  predicate: () => boolean,
  opts: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 1000;
  const interval = opts.interval ?? 5;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`until: predicate did not become true within ${timeout}ms`);
    }
    await new Promise<void>((r) => setTimeout(r, interval));
  }
}

test("createChannelServer lists bridge_reply, bridge_progress, bridge_done tools", async () => {
  const { server } = createChannelServer({ sessionId: "s1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.listTools();
  const names = result.tools.map((t) => t.name).sort();
  expect(names).toEqual(["bridge_done", "bridge_progress", "bridge_reply"]);

  const reply = result.tools.find((t) => t.name === "bridge_reply");
  expect(reply?.inputSchema?.type).toBe("object");
  expect((reply?.inputSchema as { properties?: Record<string, unknown> }).properties).toMatchObject(
    {
      content: { type: "string" },
      final: { type: "boolean" },
      messageId: { type: "string" },
    },
  );
  expect((reply?.inputSchema as { required?: string[] }).required).toEqual(["content", "final"]);

  const progress = result.tools.find((t) => t.name === "bridge_progress");
  expect(
    (progress?.inputSchema as { properties?: Record<string, unknown> }).properties,
  ).toMatchObject({
    content: { type: "string" },
    messageId: { type: "string" },
  });
  expect((progress?.inputSchema as { required?: string[] }).required).toEqual(["content"]);

  const done = result.tools.find((t) => t.name === "bridge_done");
  expect((done?.inputSchema as { properties?: Record<string, unknown> }).properties).toMatchObject({
    reason: { type: "string" },
    messageId: { type: "string" },
  });

  await client.close();
  await server.close();
});

test("tool calls invoke onTool callback with name and args", async () => {
  type ToolCall = { name: string; args: Record<string, unknown> };
  const calls: ToolCall[] = [];
  const { server } = createChannelServer({
    sessionId: "s1",
    onTool: (name, args) => {
      calls.push({ name, args });
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "bridge_reply",
    arguments: { content: "hi", final: true, messageId: "m1" },
  });
  await client.callTool({
    name: "bridge_progress",
    arguments: { content: "tick", messageId: "m1" },
  });
  await client.callTool({
    name: "bridge_done",
    arguments: { reason: "ok" },
  });

  expect(calls).toEqual([
    { name: "bridge_reply", args: { content: "hi", final: true, messageId: "m1" } },
    { name: "bridge_progress", args: { content: "tick", messageId: "m1" } },
    { name: "bridge_done", args: { reason: "ok" } },
  ]);

  await client.close();
  await server.close();
});

test("onTool errors are surfaced as MCP tool errors", async () => {
  const { server } = createChannelServer({
    sessionId: "s1",
    onTool: () => {
      throw new Error("boom");
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "bridge_reply",
    arguments: { content: "x", final: true },
  });
  expect(result.isError).toBe(true);

  await client.close();
  await server.close();
});

test("deliver emits notifications/claude/channel with session_id and message_id meta", async () => {
  const handle = createChannelServer({ sessionId: "sess-A" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const received: Array<{ content: string; meta?: Record<string, unknown> }> = [];
  client.setNotificationHandler(ChannelNotificationSchema, (n) => {
    const params = n.params as { content: string; meta?: Record<string, unknown> };
    received.push({ content: params.content, meta: params.meta });
  });

  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  await handle.deliver("hello", { messageId: "m2", meta: { foo: "bar" } });
  await until(() => received.length > 0);

  expect(received).toHaveLength(1);
  expect(received[0]?.content).toBe("hello");
  expect(received[0]?.meta).toMatchObject({
    session_id: "sess-A",
    message_id: "m2",
    foo: "bar",
  });

  await client.close();
  await handle.server.close();
});

test("deliver without messageId still includes session_id in meta", async () => {
  const handle = createChannelServer({ sessionId: "sess-B" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const received: Array<{ content: string; meta?: Record<string, unknown> }> = [];
  client.setNotificationHandler(ChannelNotificationSchema, (n) => {
    const params = n.params as { content: string; meta?: Record<string, unknown> };
    received.push({ content: params.content, meta: params.meta });
  });

  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  await handle.deliver("just content");
  await until(() => received.length > 0);

  expect(received).toHaveLength(1);
  expect(received[0]?.meta).toMatchObject({ session_id: "sess-B" });
  expect(received[0]?.meta?.message_id).toBeUndefined();

  await client.close();
  await handle.server.close();
});

test("invalid tool args return isError without invoking onTool", async () => {
  let invocations = 0;
  const { server } = createChannelServer({
    sessionId: "s1",
    onTool: () => {
      invocations++;
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const missingFinal = await client.callTool({
    name: "bridge_reply",
    arguments: { content: "x" },
  });
  expect(missingFinal.isError).toBe(true);

  const wrongType = await client.callTool({
    name: "bridge_reply",
    arguments: { content: "x", final: "yes" },
  });
  expect(wrongType.isError).toBe(true);

  const missingContent = await client.callTool({
    name: "bridge_progress",
    arguments: { messageId: "m1" },
  });
  expect(missingContent.isError).toBe(true);

  expect(invocations).toBe(0);

  const good = await client.callTool({
    name: "bridge_reply",
    arguments: { content: "x", final: true },
  });
  expect(good.isError).toBeUndefined();
  expect(invocations).toBe(1);

  await client.close();
  await server.close();
});

test("deliver rejects meta keys that are not valid identifiers", async () => {
  const handle = createChannelServer({ sessionId: "sess-X" });
  await expect(
    handle.deliver("hello", { meta: { "request-id": "x" } as Record<string, string> }),
  ).rejects.toThrow(/invalid meta key/);
});

test("deliver rejects reserved meta keys session_id and message_id", async () => {
  const handle = createChannelServer({ sessionId: "sess-R" });
  await expect(handle.deliver("hello", { meta: { session_id: "x" } })).rejects.toThrow(
    /meta key is reserved: session_id/,
  );
  await expect(handle.deliver("hello", { meta: { message_id: "x" } })).rejects.toThrow(
    /meta key is reserved: message_id/,
  );
});

test("deliver rejects non-string meta values", async () => {
  const handle = createChannelServer({ sessionId: "sess-X" });
  await expect(
    handle.deliver("hello", { meta: { request_id: 123 as unknown as string } }),
  ).rejects.toThrow(/meta value must be string/);
});

test("deliver accepts valid identifier meta keys with string values", async () => {
  const handle = createChannelServer({ sessionId: "sess-Y" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const received: Array<{ content: string; meta?: Record<string, unknown> }> = [];
  client.setNotificationHandler(ChannelNotificationSchema, (n) => {
    const params = n.params as { content: string; meta?: Record<string, unknown> };
    received.push({ content: params.content, meta: params.meta });
  });

  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  await handle.deliver("hello", { meta: { request_id: "x" } });
  await until(() => received.length > 0);

  expect(received).toHaveLength(1);
  expect(received[0]?.meta).toMatchObject({ session_id: "sess-Y", request_id: "x" });

  await client.close();
  await handle.server.close();
});

test("createChannelServer advertises claude/channel and tools capabilities", async () => {
  const { server } = createChannelServer({ sessionId: "s1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const caps = client.getServerCapabilities();
  expect(caps?.tools).toBeDefined();
  expect(caps?.experimental?.["claude/channel"]).toEqual({});

  const instructions = client.getInstructions();
  expect(typeof instructions).toBe("string");
  expect(instructions).toContain("bridge_reply");

  await client.close();
  await server.close();
});

test("permission capability is declared only when enablePermissionRelay is set", async () => {
  // Without enablePermissionRelay: claude/channel/permission must be absent
  const { server: serverOff } = createChannelServer({ sessionId: "s-cap" });
  const [serverTransportOff, clientTransportOff] = InMemoryTransport.createLinkedPair();
  const clientOff = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([serverOff.connect(serverTransportOff), clientOff.connect(clientTransportOff)]);
  const capsOff = clientOff.getServerCapabilities();
  expect(capsOff?.experimental?.["claude/channel/permission"]).toBeUndefined();
  await clientOff.close();
  await serverOff.close();

  // With enablePermissionRelay: claude/channel/permission must equal {}
  const { server: serverOn } = createChannelServer({
    sessionId: "s-cap2",
    enablePermissionRelay: true,
  });
  const [serverTransportOn, clientTransportOn] = InMemoryTransport.createLinkedPair();
  const clientOn = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([serverOn.connect(serverTransportOn), clientOn.connect(clientTransportOn)]);
  const capsOn = clientOn.getServerCapabilities();
  expect(capsOn?.experimental?.["claude/channel/permission"]).toEqual({});
  await clientOn.close();
  await serverOn.close();
});

test("permission_request notification invokes onPermissionRequest with camelCase fields", async () => {
  const reqs: Array<Record<string, string>> = [];
  const handle = createChannelServer({
    sessionId: "s-pr",
    enablePermissionRelay: true,
    onPermissionRequest: (req) => {
      reqs.push({ ...req });
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const peer = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([handle.server.connect(serverTransport), peer.connect(clientTransport)]);

  await peer.notification({
    method: "notifications/claude/channel/permission_request",
    params: {
      request_id: "abcde",
      tool_name: "Bash",
      description: "run ls",
      input_preview: "{}",
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(reqs).toEqual([
    { requestId: "abcde", toolName: "Bash", description: "run ls", inputPreview: "{}" },
  ]);

  await peer.close();
  await handle.server.close();
});

test("respondPermission emits the verdict notification", async () => {
  const handle = createChannelServer({ sessionId: "s-rv", enablePermissionRelay: true });
  const seen: Array<Record<string, unknown>> = [];
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  const PermissionVerdictSchema = NotificationSchema.extend({
    method: z.literal("notifications/claude/channel/permission"),
    params: z.looseObject({
      request_id: z.string(),
      behavior: z.string(),
    }),
  });

  const peer = new Client({ name: "test-client", version: "0.0.0" });
  peer.setNotificationHandler(PermissionVerdictSchema, (n) => {
    seen.push(n.params as Record<string, unknown>);
  });

  await Promise.all([handle.server.connect(serverTransport), peer.connect(clientTransport)]);

  await handle.respondPermission("abcde", "allow");
  await new Promise((r) => setTimeout(r, 50));
  expect(seen).toEqual([{ request_id: "abcde", behavior: "allow" }]);

  await peer.close();
  await handle.server.close();
});
