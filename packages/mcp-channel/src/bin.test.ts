import { expect, test } from "bun:test";
import { ControlServer } from "./control.ts";

const BIN_PATH = new URL("./bin.ts", import.meta.url).pathname;

// Drives the MCP `initialize` handshake over the child's stdin, the way claude
// does. The bin gates its bridge `hello` on this completing (`oninitialized`),
// so tests that expect a hello must send it.
async function completeMcpInitialize(child: Bun.Subprocess): Promise<void> {
  const init = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bin-test", version: "1" },
    },
  })}\n`;
  const initialized = `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`;
  const stdin = child.stdin as { write: (s: string) => void; flush: () => Promise<number> };
  stdin.write(init);
  await stdin.flush();
  stdin.write(initialized);
  await stdin.flush();
}

async function findUnusedPort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not allocate port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.once("error", reject);
  });
}

test(
  "ccb-channel-server bin exits with code 2 when CCB_CONNECT_TIMEOUT_MS is not a positive number",
  async () => {
    const child = Bun.spawn({
      cmd: ["bun", BIN_PATH],
      env: {
        ...process.env,
        CCB_BRIDGE_ENDPOINT: "127.0.0.1:1",
        CCB_SESSION_ID: "bin-bad-timeout",
        CCB_CONNECT_TIMEOUT_MS: "abc",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const exitCode = await Promise.race([
        child.exited,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("bin did not exit within 5s")), 5000),
        ),
      ]);
      expect(exitCode).toBe(2);
      const stderr = await new Response(child.stderr).text();
      expect(stderr).toMatch(/must be a positive number/);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  },
  { timeout: 10_000 },
);

test(
  "ccb-channel-server bin exits with code 3 when connect times out",
  async () => {
    const port = await findUnusedPort();
    const child = Bun.spawn({
      cmd: ["bun", BIN_PATH],
      env: {
        ...process.env,
        CCB_BRIDGE_ENDPOINT: `127.0.0.1:${port}`,
        CCB_SESSION_ID: "bin-timeout",
        CCB_CONNECT_TIMEOUT_MS: "300",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const exitCode = await Promise.race([
        child.exited,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("bin did not exit within 5s")), 5000),
        ),
      ]);
      expect(exitCode).toBe(3);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }
  },
  { timeout: 10_000 },
);

test(
  "ccb-channel-server bin exits promptly on SIGTERM during connect (no full connect-timeout wait)",
  async () => {
    // Endpoint that accepts the TCP connection but never sends hello_ack, so
    // the bin would otherwise block on the 10s connect timeout. SIGTERM should
    // short-circuit via the shutdown handler installed before connect.
    const net = await import("node:net");
    const sockets: Array<import("node:net").Socket> = [];
    const bareServer = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => bareServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = bareServer.address() as { port: number } | null;
    if (!addr) throw new Error("no addr");

    const child = Bun.spawn({
      cmd: ["bun", BIN_PATH],
      env: {
        ...process.env,
        CCB_BRIDGE_ENDPOINT: `127.0.0.1:${addr.port}`,
        CCB_SESSION_ID: "bin-early-sigterm",
        CCB_CONNECT_TIMEOUT_MS: "10000",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Give the bin a moment to install its signal handlers, then SIGTERM it.
      await new Promise<void>((r) => setTimeout(r, 250));
      const start = Date.now();
      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        child.exited,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("bin did not exit within 5s of SIGTERM")), 5000),
        ),
      ]);
      const elapsed = Date.now() - start;
      // Must exit well before the 10s connect timeout would have fired.
      expect(elapsed).toBeLessThan(3500);
      expect(typeof exitCode === "number" || exitCode === null).toBe(true);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    }
  },
  { timeout: 15_000 },
);

test(
  "ccb-channel-server bin withholds bridge hello until claude completes MCP initialize",
  async () => {
    // Regression: the bin used to send `hello` as soon as its TCP control
    // connection opened, i.e. before claude finished the MCP handshake and
    // registered its channel-notification handler. The bridge would then
    // deliver the first message into that window and claude would drop it
    // (notifications mid-init are discarded, not queued). `hello` must wait
    // for `oninitialized`. Settle disabled to isolate the gate from its margin.
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });

    let helloSeen = false;
    const helloPromise = new Promise<string>((resolve) => {
      server.on("hello", (sessionId) => {
        helloSeen = true;
        resolve(sessionId);
      });
    });

    const child = Bun.spawn({
      cmd: ["bun", BIN_PATH],
      env: {
        ...process.env,
        CCB_BRIDGE_ENDPOINT: info.endpoint,
        CCB_SESSION_ID: "bin-gate-1",
        CCB_CHANNEL_READY_SETTLE_MS: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Without an MCP initialize, hello must not fire.
      await new Promise((r) => setTimeout(r, 800));
      expect(helloSeen).toBe(false);

      // Drive the handshake; now hello is allowed.
      await completeMcpInitialize(child);
      const sessionId = await Promise.race([
        helloPromise,
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for hello after initialize")), 5000),
        ),
      ]);
      expect(sessionId).toBe("bin-gate-1");
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      await server.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "ccb-channel-server bin connects via CCB_BRIDGE_ENDPOINT and completes hello handshake",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });

    const helloPromise = new Promise<string>((resolve) => {
      server.on("hello", (sessionId) => resolve(sessionId));
    });

    const child = Bun.spawn({
      cmd: ["bun", BIN_PATH],
      env: {
        ...process.env,
        CCB_BRIDGE_ENDPOINT: info.endpoint,
        CCB_SESSION_ID: "bin-test-1",
        CCB_CHANNEL_READY_SETTLE_MS: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await completeMcpInitialize(child);
      const sessionId = await Promise.race([
        helloPromise,
        new Promise<string>((_resolve, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for hello")), 5000),
        ),
      ]);
      expect(sessionId).toBe("bin-test-1");

      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        child.exited,
        new Promise<number>((_resolve, reject) =>
          setTimeout(() => reject(new Error("bin did not exit within 3s of SIGTERM")), 3000),
        ),
      ]);
      // Either a clean 0 from our shutdown handler or null/non-zero from signal-only termination
      // is acceptable as long as the process actually exited.
      expect(typeof exitCode === "number" || exitCode === null).toBe(true);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      await server.close();
    }
  },
  { timeout: 15_000 },
);
