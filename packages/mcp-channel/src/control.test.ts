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

test("parseEndpoint rejects port > 65535", () => {
  expect(() => parseEndpoint("127.0.0.1:65536")).toThrow();
  expect(() => parseEndpoint("127.0.0.1:99999")).toThrow();
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

test("ControlClient.connect rejects fast when server destroys socket before hello_ack", async () => {
  // Simulate a server that accepts hello and immediately destroys the socket
  // (e.g., duplicate session or hello timeout server-side).
  const net = await import("node:net");
  const bareServer = net.createServer((socket) => {
    socket.on("data", () => {
      // After receiving any data (the hello), destroy the socket.
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = bareServer.address() as { port: number } | null;
  if (!addr) throw new Error("no addr");

  const client = new ControlClient({
    endpoint: `127.0.0.1:${addr.port}`,
    sessionId: "fast-fail",
    onDeliver: () => {},
    helloAckTimeoutMs: 5_000,
  });

  const start = Date.now();
  await expect(client.connect()).rejects.toThrow(/closed before hello_ack/);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(500);

  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
});

test("ControlServer.close completes within ~1500ms even with stalled client", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  // Use a raw socket so we can pause it (stop draining), forcing the server's
  // writes to hang. Complete the hello handshake first to register the session.
  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  sock.write(`${JSON.stringify({ type: "hello", sessionId: "stall-srv" })}\n`);
  // Wait for the hello_ack to arrive so we know server registered the session.
  await new Promise<void>((resolve) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.includes("hello_ack")) resolve();
    });
  });
  // Now pause the socket so server's subsequent writes will not drain.
  sock.pause();

  const start = Date.now();
  await server.close();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1_500);

  sock.destroy();
});

test("ControlClient.close completes within ~1500ms even when server is stalled", async () => {
  // Build a bare TCP server that completes the hello/ack handshake but then
  // pauses the server-side socket so any subsequent writes from the client
  // are not drained.
  const net = await import("node:net");
  const serverSockets: Array<import("node:net").Socket> = [];
  const bareServer = net.createServer((socket) => {
    serverSockets.push(socket);
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // Expect hello — respond with hello_ack then pause.
        if (line.includes('"hello"')) {
          socket.write(`${JSON.stringify({ type: "hello_ack" })}\n`, () => {
            socket.pause();
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = bareServer.address() as { port: number } | null;
  if (!addr) throw new Error("no addr");

  const client = new ControlClient({
    endpoint: `127.0.0.1:${addr.port}`,
    sessionId: "stall-cli",
    onDeliver: () => {},
  });
  await client.connect();

  const start = Date.now();
  await client.close();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1_500);

  for (const s of serverSockets) s.destroy();
  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
});

test("ControlClient.close after onConnectionLost resolves immediately", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  let lost = 0;
  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "loss-fast",
    onDeliver: () => {},
    onConnectionLost: () => {
      lost++;
    },
  });
  await client.connect();

  await server.close();
  await until(() => lost > 0, { timeout: 1000 });

  const start = Date.now();
  await client.close();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(100);
});

test("ControlClient.onConnectionLost fires exactly once on broken connection", async () => {
  // Build a bare server we can RST: do the hello/ack then forcibly destroy
  // (RST-like) — Node usually emits 'error' then 'close' on RST.
  const net = await import("node:net");
  let serverSock: import("node:net").Socket | undefined;
  const bareServer = net.createServer((socket) => {
    serverSock = socket;
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.includes('"hello"')) {
          socket.write(`${JSON.stringify({ type: "hello_ack" })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = bareServer.address() as { port: number } | null;
  if (!addr) throw new Error("no addr");

  let lost = 0;
  const client = new ControlClient({
    endpoint: `127.0.0.1:${addr.port}`,
    sessionId: "loss-dedupe",
    onDeliver: () => {},
    onConnectionLost: () => {
      lost++;
    },
  });
  await client.connect();

  // Force RST by destroying with an error.
  serverSock?.destroy(new Error("forced reset"));

  // Wait long enough that both error and close listeners would have fired.
  await new Promise<void>((r) => setTimeout(r, 200));
  expect(lost).toBe(1);

  await client.close();
  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
});

test("ControlClient.connect rejects without leaving #socket set; sendTool throws 'not connected'", async () => {
  // A bare TCP server that accepts but never sends hello_ack and then closes
  // the socket so the connect promise rejects after the connection is established.
  const net = await import("node:net");
  const bareServer = net.createServer((socket) => {
    socket.on("data", () => {
      // Drop hello; close socket to trigger connect rejection mid-handshake.
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = bareServer.address() as { port: number } | null;
  if (!addr) throw new Error("no addr");

  const client = new ControlClient({
    endpoint: `127.0.0.1:${addr.port}`,
    sessionId: "no-ack",
    onDeliver: () => {},
    helloAckTimeoutMs: 5_000,
  });

  await expect(client.connect()).rejects.toThrow();
  await expect(client.sendTool("bridge_done", {})).rejects.toThrow(/not connected/);

  await new Promise<void>((resolve) => bareServer.close(() => resolve()));
});

test("hello_ack reaches client before deliver triggered from hello listener", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  // Server immediately delivers a message from the hello listener (synchronous
  // call to server.deliver). The hello_ack write must reach the wire before
  // the deliver frame so the client never sees deliver before hello_ack.
  server.on("hello", (sessionId) => {
    void server.deliver(sessionId, "from-hello", { messageId: "m-hello" });
  });

  // Connect via raw socket so we can observe the exact line ordering.
  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));

  sock.setEncoding("utf8");
  const lines: string[] = [];
  let buf = "";
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  });

  sock.write(`${JSON.stringify({ type: "hello", sessionId: "order-1" })}\n`);
  await until(() => lines.length >= 2, { timeout: 1000 });

  // The first received line must be hello_ack, then deliver.
  expect(lines[0]).toContain("hello_ack");
  expect(lines[1]).toContain("deliver");

  sock.destroy();
  await server.close();
});

test("ControlServer survives a throwing tool listener and keeps dispatching", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };

  try {
    let calls = 0;
    server.on("tool", () => {
      calls++;
      if (calls === 1) throw new Error("listener boom");
    });

    const client = new ControlClient({
      endpoint: info.endpoint,
      sessionId: "throw-1",
      onDeliver: () => {},
    });
    await client.connect();

    await client.sendTool("bridge_done", { reason: "first" });
    await client.sendTool("bridge_done", { reason: "second" });
    await until(() => calls >= 2, { timeout: 1000 });

    expect(calls).toBe(2);
    expect(errors.some((m) => m.includes("listener boom"))).toBe(true);

    await client.close();
    await server.close();
  } finally {
    console.error = originalError;
  }
});

test("ControlServer.deliver validates meta keys and rejects reserved keys", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "meta-1",
    onDeliver: () => {},
  });
  await client.connect();

  await expect(
    server.deliver("meta-1", "x", { meta: { "request-id": "x" } as Record<string, string> }),
  ).rejects.toThrow(/invalid meta key/);
  await expect(server.deliver("meta-1", "x", { meta: { session_id: "x" } })).rejects.toThrow(
    /reserved/,
  );
  await expect(server.deliver("meta-1", "x", { meta: { message_id: "x" } })).rejects.toThrow(
    /reserved/,
  );
  await expect(
    server.deliver("meta-1", "x", { meta: { request_id: 123 as unknown as string } }),
  ).rejects.toThrow(/meta value must be string/);

  // Valid identifier and non-reserved keys still work.
  await server.deliver("meta-1", "ok", { meta: { request_id: "x" } });

  await client.close();
  await server.close();
});

test("ControlServer drops oversized single-line frames", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  const closed = new Promise<void>((resolve) => sock.on("close", () => resolve()));
  // Single line larger than MAX_FRAME_BYTES (16 MiB) with no newline.
  // We rely on the buffer-size check rejecting it.
  const big = "a".repeat(17 * 1024 * 1024);
  sock.on("error", () => {});
  sock.write(big);

  await Promise.race([
    closed,
    new Promise<void>((_r, reject) =>
      setTimeout(() => reject(new Error("oversized single-line socket not destroyed")), 2000),
    ),
  ]);

  await server.close();
});

test("ControlServer keeps socket alive when individual lines are within cap (multi-line buffer)", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });

  const helloIds: string[] = [];
  server.on("hello", (sessionId) => {
    helloIds.push(sessionId);
  });
  const toolCalls: Array<{ name: string }> = [];
  server.on("tool", (_sid, name) => {
    toolCalls.push({ name });
  });

  const net = await import("node:net");
  const sock = net.createConnection({ host: info.host, port: info.port });
  await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
  sock.on("error", () => {});

  // Two lines, each ~8 MB but well under the 16 MiB single-frame cap.
  // Combined the chunk could grow over 16 MiB depending on how Node delivers
  // it; the per-line check must allow this through.
  const helloLine = `${JSON.stringify({ type: "hello", sessionId: "multi-1" })}\n`;
  const padding = "x".repeat(8 * 1024 * 1024);
  const toolLine = `${JSON.stringify({ type: "tool", name: "bridge_done", args: { p: padding } })}\n`;

  sock.write(helloLine);
  sock.write(toolLine);
  sock.write(toolLine);

  await until(() => toolCalls.length >= 2, { timeout: 10_000 });
  expect(helloIds).toEqual(["multi-1"]);
  expect(toolCalls.length).toBe(2);
  // Socket should still be alive (not destroyed).
  expect(sock.destroyed).toBe(false);

  sock.destroy();
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
