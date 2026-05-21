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
  readonly endpoint: string;
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
  env.CCB_BRIDGE_ENDPOINT = opts.endpoint;
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
