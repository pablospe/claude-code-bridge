import { expect, test } from "bun:test";
import { ControlServer } from "./control.ts";

const BIN_PATH = new URL("./bin.ts", import.meta.url).pathname;

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
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
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
