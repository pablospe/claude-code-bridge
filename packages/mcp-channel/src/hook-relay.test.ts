import { expect, test } from "bun:test";
import type { Server as NetServer, Socket } from "node:net";
import { ControlServer } from "./control.ts";

const RELAY_PATH = new URL("./hook-relay.ts", import.meta.url).pathname;
// Resolve the repo root from the test file's own location so the test runs
// on any host / CI runner, not just the original development machine.
// hook-relay.test.ts lives at packages/mcp-channel/src/hook-relay.test.ts —
// three levels under the repo root.
const CWD = new URL("../../..", import.meta.url).pathname;

type SpawnOpts = {
  readonly event?: string;
  readonly endpoint?: string;
  readonly sessionId?: string;
  readonly stdinPayload: string;
};

type SpawnResult = {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly elapsedMs: number;
};

async function runRelay(opts: SpawnOpts): Promise<SpawnResult> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts.endpoint !== undefined) env.CCB_BRIDGE_ENDPOINT = opts.endpoint;
  else delete env.CCB_BRIDGE_ENDPOINT;
  if (opts.sessionId !== undefined) env.CCB_SESSION_ID = opts.sessionId;
  else delete env.CCB_SESSION_ID;

  const cmd: string[] = ["bun", RELAY_PATH];
  if (opts.event !== undefined) cmd.push(opts.event);

  const start = Date.now();
  const child = Bun.spawn({
    cmd,
    cwd: CWD,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(opts.stdinPayload);
  await child.stdin.end();

  const exitCode = await Promise.race([
    child.exited,
    new Promise<number>((_r, reject) =>
      setTimeout(() => reject(new Error("relay did not exit within 5s")), 5000),
    ),
  ]);
  const elapsedMs = Date.now() - start;
  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();
  return { exitCode, stderr, stdout, elapsedMs };
}

test(
  "happy path: relay sends one hook frame after hello_ack",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });

    type HookCall = { sessionId: string; event: string; payload: Record<string, unknown> };
    const hooks: HookCall[] = [];
    server.on("hook", (sessionId, event, payload) => {
      hooks.push({ sessionId, event, payload });
    });

    const payload = { tool_name: "Bash", tool_input: { command: "ls" } };
    const result = await runRelay({
      event: "PreToolUse",
      endpoint: info.endpoint,
      sessionId: "sess-happy",
      stdinPayload: JSON.stringify(payload),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    // Wait briefly for the server to dispatch the hook event.
    for (let i = 0; i < 50 && hooks.length === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.sessionId).toBe("sess-happy");
    expect(hooks[0]?.event).toBe("PreToolUse");
    expect(hooks[0]?.payload).toEqual(payload);

    await server.close();
  },
  { timeout: 10_000 },
);

test(
  "bridge-unreachable: exit 0, stderr line, never connects",
  async () => {
    // A separate listener that simply tracks any inbound connection. The relay
    // is pointed at a closed port (127.0.0.1:1) so no connection should ever
    // arrive at this listener.
    const net = await import("node:net");
    let connectionCount = 0;
    const witness = net.createServer(() => {
      connectionCount++;
    });
    await new Promise<void>((r) => witness.listen(0, "127.0.0.1", () => r()));

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: "127.0.0.1:1",
      sessionId: "sess-unreach",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^ccb-hook-relay:/m);
    expect(connectionCount).toBe(0);

    await new Promise<void>((r) => witness.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "malformed stdin JSON: exit 0, stderr line",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });
    const hooks: unknown[] = [];
    server.on("hook", (sid, ev, p) => hooks.push({ sid, ev, p }));

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: info.endpoint,
      sessionId: "sess-bad-json",
      stdinPayload: "{invalid",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^ccb-hook-relay:/m);
    expect(hooks).toEqual([]);

    await server.close();
  },
  { timeout: 10_000 },
);

test(
  "missing CCB_SESSION_ID: exit 0, stderr, no TCP connect",
  async () => {
    const net = await import("node:net");
    let connectionCount = 0;
    const witness: NetServer = net.createServer(() => {
      connectionCount++;
    });
    await new Promise<void>((r) => witness.listen(0, "127.0.0.1", () => r()));
    const addr = witness.address() as { port: number };

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: undefined,
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: missing CCB_SESSION_ID/);
    expect(connectionCount).toBe(0);

    await new Promise<void>((r) => witness.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "invalid event name: exit 0, stderr line",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });
    const hooks: unknown[] = [];
    server.on("hook", (sid, ev, p) => hooks.push({ sid, ev, p }));

    const result = await runRelay({
      event: "UnknownEvent",
      endpoint: info.endpoint,
      sessionId: "sess-bad-event",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: invalid event name/);
    expect(hooks).toEqual([]);

    await server.close();
  },
  { timeout: 10_000 },
);

test(
  "missing event name: exit 0, stderr line",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });

    const result = await runRelay({
      event: undefined,
      endpoint: info.endpoint,
      sessionId: "sess-no-event",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: invalid event name/);

    await server.close();
  },
  { timeout: 10_000 },
);

test(
  "hello timeout: server accepts but never acks, relay exits 0 within budget",
  async () => {
    // Bare TCP server that accepts but never sends hello_ack. The relay's
    // 500ms wall-clock cap (200ms hello cap inside it) must fire and force exit.
    const net = await import("node:net");
    const sockets: Socket[] = [];
    const bare = net.createServer((s) => {
      sockets.push(s);
      s.on("error", () => {});
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
    const addr = bare.address() as { port: number };

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: "sess-no-ack",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^ccb-hook-relay:/m);
    // Relay budget is 500ms; the rest is subprocess (bun) cold-start, well
    // under ~1s. 2500ms tolerates spawn variance while still failing if the
    // 500ms cap regresses to multiple seconds (the loose 5000ms bound let a
    // ~10x regression pass).
    expect(result.elapsedMs).toBeLessThan(2500);

    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => bare.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "payload not an object (string): exit 0, stderr line",
  async () => {
    const server = new ControlServer();
    const info = await server.listen({ host: "127.0.0.1", port: 0 });
    const hooks: unknown[] = [];
    server.on("hook", (sid, ev, p) => hooks.push({ sid, ev, p }));

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: info.endpoint,
      sessionId: "sess-str-payload",
      stdinPayload: JSON.stringify("a string"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^ccb-hook-relay:/m);
    expect(hooks).toEqual([]);

    await server.close();
  },
  { timeout: 10_000 },
);

test(
  "missing CCB_BRIDGE_ENDPOINT: exit 0, stderr line",
  async () => {
    const result = await runRelay({
      event: "PreToolUse",
      endpoint: undefined,
      sessionId: "sess-no-endpoint",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: missing CCB_BRIDGE_ENDPOINT/);
  },
  { timeout: 10_000 },
);

test(
  "invalid endpoint: exit 0, stderr line, no TCP connect",
  async () => {
    // A malformed endpoint (no port) fails parseEndpoint before any connect.
    // A witness listener confirms the relay never opens a socket.
    const net = await import("node:net");
    let connectionCount = 0;
    const witness = net.createServer(() => {
      connectionCount++;
    });
    await new Promise<void>((r) => witness.listen(0, "127.0.0.1", () => r()));

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: "not-a-host-port",
      sessionId: "sess-bad-endpoint",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: invalid endpoint/);
    expect(connectionCount).toBe(0);

    await new Promise<void>((r) => witness.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "malformed hello_ack: server sends non-JSON line, relay exits 0 with stderr",
  async () => {
    // Bare TCP server that accepts and replies with a line that is not JSON.
    // waitForHelloAck must reject with "malformed hello_ack".
    const net = await import("node:net");
    const sockets: Socket[] = [];
    const bare = net.createServer((s) => {
      sockets.push(s);
      s.on("error", () => {});
      s.write("this is not json\n");
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
    const addr = bare.address() as { port: number };

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: "sess-bad-ack",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: malformed hello_ack/);
    expect(result.elapsedMs).toBeLessThan(2500);

    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => bare.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "socket closed before hello_ack: relay exits 0 with stderr",
  async () => {
    // Bare TCP server that accepts then immediately closes the connection
    // without ever sending hello_ack. waitForHelloAck must reject with
    // "socket closed before hello_ack".
    const net = await import("node:net");
    const bare = net.createServer((s) => {
      s.on("error", () => {});
      s.end();
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
    const addr = bare.address() as { port: number };

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: "sess-closed",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/ccb-hook-relay: socket closed before hello_ack/);
    expect(result.elapsedMs).toBeLessThan(2500);

    await new Promise<void>((r) => bare.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "send/close timeout: server acks then stalls, relay exits 0 within budget",
  async () => {
    // Bare TCP server that acks the hello but never reads or closes its end, so
    // socket.end()'s callback never fires. The 100ms send/close slice (and the
    // 500ms total budget) must fire and force a clean exit.
    const net = await import("node:net");
    const sockets: Socket[] = [];
    const bare = net.createServer((s) => {
      sockets.push(s);
      s.on("error", () => {});
      // Pause so the server never consumes / completes the relay's end().
      s.pause();
      s.write(`${JSON.stringify({ type: "hello_ack" })}\n`);
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
    const addr = bare.address() as { port: number };

    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: "sess-send-stall",
      stdinPayload: JSON.stringify({ tool_name: "Bash" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.elapsedMs).toBeLessThan(2500);

    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => bare.close(() => r()));
  },
  { timeout: 10_000 },
);

test(
  "oversized tool_input is truncated on the wire and listed in truncated_fields",
  async () => {
    // Bare TCP server that completes the handshake, then captures the hook
    // frame the relay sends. The relay truncates per-field before writing, so
    // the wire payload must carry a bounded tool_input and a truncated_fields
    // marker.
    const { HOOK_MAX_FIELD_BYTES } = await import("@ccb/core");
    const net = await import("node:net");
    const sockets: Socket[] = [];
    let captured: Record<string, unknown> | undefined;
    const bare = net.createServer((s) => {
      sockets.push(s);
      s.setEncoding("utf8");
      s.on("error", () => {});
      let buf = "";
      s.on("data", (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            idx = buf.indexOf("\n");
            continue;
          }
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { type?: unknown }).type === "hello"
          ) {
            s.write(`${JSON.stringify({ type: "hello_ack" })}\n`);
          } else if (
            typeof parsed === "object" &&
            parsed !== null &&
            (parsed as { type?: unknown }).type === "hook"
          ) {
            captured = parsed as Record<string, unknown>;
          }
          idx = buf.indexOf("\n");
        }
      });
    });
    await new Promise<void>((r) => bare.listen(0, "127.0.0.1", () => r()));
    const addr = bare.address() as { port: number };

    const huge = "x".repeat(HOOK_MAX_FIELD_BYTES + 5000);
    const result = await runRelay({
      event: "PreToolUse",
      endpoint: `127.0.0.1:${addr.port}`,
      sessionId: "sess-truncate",
      stdinPayload: JSON.stringify({ tool_name: "Bash", tool_input: huge }),
    });
    expect(result.exitCode).toBe(0);

    for (let i = 0; i < 100 && captured === undefined; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(captured).toBeDefined();
    const wirePayload = captured?.payload as Record<string, unknown>;
    expect(wirePayload.truncated_fields).toEqual(["tool_input"]);
    const wireInput = wirePayload.tool_input as string;
    expect(typeof wireInput).toBe("string");
    expect(wireInput.length).toBeLessThan(huge.length);
    // The cap is measured against the JSON-serialized form of the value.
    expect(Buffer.byteLength(JSON.stringify(wireInput), "utf8")).toBeLessThanOrEqual(
      HOOK_MAX_FIELD_BYTES,
    );

    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => bare.close(() => r()));
  },
  { timeout: 10_000 },
);
