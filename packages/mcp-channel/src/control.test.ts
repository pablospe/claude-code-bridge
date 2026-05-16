import { expect, test } from "bun:test";
import { ControlClient, ControlServer, parseEndpoint } from "./control.ts";

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
  await until(() => helloSessionId === "sess-1");
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
  await until(() => calls.length > 0);

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

  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "sess-3",
    onDeliver: (content, opts) => {
      got.push({ content, opts: opts ?? {} });
    },
  });
  await client.connect();

  await server.deliver("sess-3", "incoming", { messageId: "m3", meta: { k: "v" } });
  await until(() => got.length > 0);

  expect(got).toEqual([{ content: "incoming", opts: { messageId: "m3", meta: { k: "v" } } }]);

  await client.close();
  await server.close();
});

test("parseEndpoint handles IPv6 bracket form", () => {
  expect(parseEndpoint("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
  expect(parseEndpoint("127.0.0.1:5000")).toEqual({ host: "127.0.0.1", port: 5000 });
});

test("parseEndpoint rejects invalid forms", () => {
  expect(() => parseEndpoint("badendpoint")).toThrow();
  expect(() => parseEndpoint("127.0.0.1:")).toThrow();
  expect(() => parseEndpoint("[::1]:")).toThrow();
  expect(() => parseEndpoint("[::1]")).toThrow();
});

test("ControlServer destroys pre-hello sockets after helloTimeoutMs", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0, helloTimeoutMs: 80 });

  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));

  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  await Promise.race([
    closed,
    new Promise<void>((_r, reject) =>
      setTimeout(() => reject(new Error("socket not closed")), 500),
    ),
  ]);

  await server.close();
});

test("ControlServer.close destroys pre-hello sockets immediately", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0, helloTimeoutMs: 10_000 });

  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));

  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  await server.close();
  await Promise.race([
    closed,
    new Promise<void>((_r, reject) =>
      setTimeout(() => reject(new Error("socket not closed on server.close()")), 500),
    ),
  ]);
});

test("ControlClient.connect resolves only after hello_ack arrives", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  let connected = false;
  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "ack-1",
    onDeliver: () => {},
  });
  const connectPromise = client.connect().then(() => {
    connected = true;
  });
  await connectPromise;
  expect(connected).toBe(true);

  await client.close();
  await server.close();
});

test("ControlClient.connect rejects when server never acks", async () => {
  // Spin up a bare TCP server that accepts but never speaks.
  const net = await import("node:net");
  const bareServer = net.createServer(() => {
    // do not write anything
  });
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = bareServer.address() as { port: number } | null;
  if (!addr) throw new Error("no addr");

  const client = new ControlClient({
    endpoint: `127.0.0.1:${addr.port}`,
    sessionId: "no-ack",
    onDeliver: () => {},
    helloAckTimeoutMs: 80,
  });

  await expect(client.connect()).rejects.toThrow(/hello_ack/);

  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
});

test("ControlServer rejects duplicate sessionId hello", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const helloIds: string[] = [];
  server.on("hello", (sessionId) => {
    helloIds.push(sessionId);
  });

  const clientA = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "dup",
    onDeliver: () => {},
  });
  await clientA.connect();
  expect(helloIds).toEqual(["dup"]);

  // Second connection with same sessionId via raw socket — should be destroyed.
  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  sock.write(`${JSON.stringify({ type: "hello", sessionId: "dup" })}\n`);
  await Promise.race([
    closed,
    new Promise<void>((_r, reject) =>
      setTimeout(() => reject(new Error("dup socket not destroyed")), 500),
    ),
  ]);

  // Original session is still operational.
  expect(helloIds).toEqual(["dup"]);

  await clientA.close();
  await server.close();
});

test("ControlServer destroys socket sending tool before hello", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const toolCalls: Array<{ name: string }> = [];
  server.on("tool", (_sid, name) => {
    toolCalls.push({ name });
  });

  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  sock.write(`${JSON.stringify({ type: "tool", name: "bridge_done", args: {} })}\n`);
  await Promise.race([
    closed,
    new Promise<void>((_r, reject) =>
      setTimeout(() => reject(new Error("pre-hello tool socket not destroyed")), 500),
    ),
  ]);
  expect(toolCalls).toHaveLength(0);

  await server.close();
});

test("ControlClient surfaces connection loss via onConnectionLost", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  let lost = 0;
  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "loss-1",
    onDeliver: () => {},
    onConnectionLost: () => {
      lost++;
    },
  });
  await client.connect();

  await server.close();
  await until(() => lost > 0, { timeout: 1000 });

  await client.close();
});

test("ControlClient logs onDeliver errors to console.error", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const originalError = console.error;
  const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args);
  };
  try {
    const client = new ControlClient({
      endpoint: info.endpoint,
      sessionId: "err-1",
      onDeliver: () => {
        throw new Error("kaboom");
      },
    });
    await client.connect();

    await server.deliver("err-1", "x");
    await until(() => messages.some((m) => m.some((s) => String(s).includes("kaboom"))), {
      timeout: 500,
    });

    await client.close();
    await server.close();
  } finally {
    console.error = originalError;
  }
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
        await until(() => helloIds.length > 0);
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
  const helloIds: string[] = [];
  server.on("hello", (sessionId) => {
    helloIds.push(sessionId);
  });
  server.on("tool", (sessionId, name, args) => {
    calls.push({ sessionId, name, args });
  });

  // Connect via raw socket to send a partial line.
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ host: info.host, port: info.port }, async () => {
      try {
        sock.write(`${JSON.stringify({ type: "hello", sessionId: "raw-1" })}\n`);
        await until(() => helloIds.length > 0);
        const line = JSON.stringify({ type: "tool", name: "bridge_done", args: {} });
        const half = Math.floor(line.length / 2);
        sock.write(line.slice(0, half));
        await new Promise<void>((r) => setTimeout(r, 10));
        // Tool listener should not have fired yet.
        expect(calls).toHaveLength(0);
        sock.write(`${line.slice(half)}\n`);
        await until(() => calls.length > 0);
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
