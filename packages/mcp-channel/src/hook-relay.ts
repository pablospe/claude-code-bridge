#!/usr/bin/env bun
import { createConnection, type Socket } from "node:net";
import { parseEndpoint } from "./control.ts";

/**
 * Hardcoded time budget in phase 1 of M3 (docs/M3.md "Readiness gate" §2).
 * Connect + hello_ack + send/close must complete inside 500ms wall-clock;
 * otherwise the relay aborts so claude's turn is never blocked on us.
 */
const TOTAL_BUDGET_MS = 500;
const CONNECT_TIMEOUT_MS = 200;
const HELLO_ACK_TIMEOUT_MS = 200;
const SEND_CLOSE_TIMEOUT_MS = 100;

const VALID_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop"]);

function fail(reason: string): never {
  process.stderr.write(`ccb-hook-relay: ${reason}\n`);
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function connectWithTimeout(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(new Error("connect timeout"));
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForHelloAck(socket: Socket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buf = "";
    socket.setEncoding("utf8");
    const onData = (chunk: string): void => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("malformed hello_ack"));
        return;
      }
      if (isRecord(parsed) && parsed.type === "hello_ack") {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("socket closed before hello_ack"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("hello_ack timeout"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function writeFrameAndClose(
  socket: Socket,
  frame: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      // Send/close phase exceeding its slice is non-fatal for observability:
      // the frame may already be on the wire; the relay still exits 0.
      resolve();
    }, timeoutMs);
    timer.unref?.();
    socket.write(`${JSON.stringify(frame)}\n`, (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
        return;
      }
      socket.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

async function relay(): Promise<void> {
  const sessionId = process.env.CCB_SESSION_ID;
  if (!sessionId) fail("missing CCB_SESSION_ID");

  const endpoint = process.env.CCB_BRIDGE_ENDPOINT;
  if (!endpoint) fail("missing CCB_BRIDGE_ENDPOINT");

  const eventArg = process.argv[2];
  if (!eventArg || !VALID_EVENTS.has(eventArg)) {
    fail(`invalid event name ${eventArg ?? "<missing>"}`);
  }

  let host: string;
  let port: number;
  try {
    ({ host, port } = parseEndpoint(endpoint));
  } catch (err) {
    fail(`invalid endpoint: ${err instanceof Error ? err.message : String(err)}`);
  }

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    fail(`stdin read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    fail(`malformed stdin json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(payload)) fail("stdin payload is not an object");

  let socket: Socket;
  try {
    socket = await connectWithTimeout(host, port, CONNECT_TIMEOUT_MS);
  } catch (err) {
    fail(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    socket.write(`${JSON.stringify({ type: "hello", sessionId, role: "hook" })}\n`);
    await waitForHelloAck(socket, HELLO_ACK_TIMEOUT_MS);

    const hookFrame = {
      type: "hook",
      sessionId,
      event: eventArg,
      payload,
      sentAt: new Date().toISOString(),
    };
    await writeFrameAndClose(socket, hookFrame, SEND_CLOSE_TIMEOUT_MS);
  } catch (err) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  await Promise.race([
    relay(),
    new Promise<void>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error("time budget exceeded")), TOTAL_BUDGET_MS);
      t.unref?.();
    }),
  ]);
  process.exit(0);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
