import { expect, test } from "bun:test";
import { ControlClient, ControlServer } from "./control.ts";

test("ControlServer.listen on port 0 returns a real endpoint with host and port", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });
  expect(info.host).toBe("127.0.0.1");
  expect(info.port).toBeGreaterThan(0);
  expect(info.endpoint).toBe(`${info.host}:${info.port}`);
  await server.close();
});

test("hello handshake completes between ControlClient and ControlServer", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  let helloSessionId: string | undefined;
  server.on("hello", (sessionId) => {
    helloSessionId = sessionId;
  });

  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "sess-1",
    onDeliver: () => {},
  });
  await client.connect();
  // give the server time to receive the hello
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(helloSessionId).toBe("sess-1");

  await client.close();
  await server.close();
});

test("ControlClient.sendTool delivers to ControlServer tool listener", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  type ToolCall = { sessionId: string; name: string; args: Record<string, unknown> };
  const calls: ToolCall[] = [];
  server.on("tool", (sessionId, name, args) => {
    calls.push({ sessionId, name, args });
  });

  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "sess-2",
    onDeliver: () => {},
  });
  await client.connect();

  await client.sendTool("bridge_reply", { content: "x", final: true });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  expect(calls).toEqual([
    { sessionId: "sess-2", name: "bridge_reply", args: { content: "x", final: true } },
  ]);

  await client.close();
  await server.close();
});

test("ControlServer.deliver triggers ControlClient.onDeliver", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  type DeliverCall = {
    content: string;
    opts: { messageId?: string; meta?: Record<string, unknown> };
  };
  const got: DeliverCall[] = [];

  const helloPromise = new Promise<void>((resolve) => {
    server.on("hello", () => resolve());
  });

  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "sess-3",
    onDeliver: (content, opts) => {
      got.push({ content, opts: opts ?? {} });
    },
  });
  await client.connect();
  await helloPromise;

  await server.deliver("sess-3", "incoming", { messageId: "m3", meta: { k: "v" } });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  expect(got).toEqual([{ content: "incoming", opts: { messageId: "m3", meta: { k: "v" } } }]);

  await client.close();
  await server.close();
});

test("ControlServer drops malformed control messages without crashing", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  type ToolCall = { sessionId: string; name: string; args: Record<string, unknown> };
  const toolCalls: ToolCall[] = [];
  const helloIds: string[] = [];
  server.on("hello", (sessionId) => {
    helloIds.push(sessionId);
  });
  server.on("tool", (sessionId, name, args) => {
    toolCalls.push({ sessionId, name, args });
  });

  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: info.host, port: info.port }, async () => {
      try {
        // wrong type for sessionId
        sock.write(`${JSON.stringify({ type: "hello", sessionId: 99 })}\n`);
        // missing required field
        sock.write(`${JSON.stringify({ type: "tool", name: "x" })}\n`);
        // unknown type
        sock.write(`${JSON.stringify({ type: "garbage" })}\n`);
        // valid hello finally
        sock.write(`${JSON.stringify({ type: "hello", sessionId: "ok-1" })}\n`);
        await new Promise<void>((r) => setTimeout(r, 30));
        expect(helloIds).toEqual(["ok-1"]);
        expect(toolCalls).toHaveLength(0);
        sock.end();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", reject);
  });

  await server.close();
});

test("ControlServer buffers partial JSON lines until newline", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  type ToolCall = { sessionId: string; name: string; args: Record<string, unknown> };
  const calls: ToolCall[] = [];
  server.on("tool", (sessionId, name, args) => {
    calls.push({ sessionId, name, args });
  });

  const helloPromise = new Promise<void>((resolve) => {
    server.on("hello", () => resolve());
  });

  // Connect via raw socket to send a partial line.
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: info.host, port: info.port }, async () => {
      try {
        sock.write(`${JSON.stringify({ type: "hello", sessionId: "raw-1" })}\n`);
        await helloPromise;
        const line = JSON.stringify({ type: "tool", name: "bridge_done", args: {} });
        const half = Math.floor(line.length / 2);
        sock.write(line.slice(0, half));
        await new Promise<void>((r) => setTimeout(r, 10));
        // Tool listener should not have fired yet.
        expect(calls).toHaveLength(0);
        sock.write(`${line.slice(half)}\n`);
        await new Promise<void>((r) => setTimeout(r, 20));
        expect(calls).toEqual([{ sessionId: "raw-1", name: "bridge_done", args: {} }]);
        sock.end();
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", reject);
  });

  await server.close();
});
