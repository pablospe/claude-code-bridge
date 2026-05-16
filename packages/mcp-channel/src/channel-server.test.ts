import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChannelServer } from "./channel-server.ts";

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
