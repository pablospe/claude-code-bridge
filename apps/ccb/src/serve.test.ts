import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeEvent } from "@ccb/core";
import { ControlClient } from "@ccb/mcp-channel";
import { runServe } from "./serve.ts";

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-serve-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

const TEST_UUID = "00000000-0000-4000-8000-000000000001";

test("runServe routes bridge_reply tool calls through the bridge as agent.reply", async () => {
  const ac = new AbortController();
  const events: BridgeEvent[] = [];
  const ready = Promise.withResolvers<{ endpoint: string; bridgeSessionId: string }>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onEvent: (ev) => {
      events.push(ev);
    },
    onReady: (info) => {
      // The wire session id is the one tests passed in; the bridge's id is
      // surfaced through events. Capture both by reading the bus.
      ready.resolve({ endpoint: info.endpoint, bridgeSessionId: "" });
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });

  const { endpoint } = await ready.promise;

  // Wait for the initial session.started event so we can capture the bridge id.
  for (let i = 0; i < 50; i++) {
    if (events.some((e) => e.type === "session.started")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const started = events.find((e) => e.type === "session.started");
  expect(started).toBeDefined();
  const bridgeSessionId = started?.sessionId ?? "";

  const client = new ControlClient({
    endpoint,
    sessionId: TEST_UUID,
    onDeliver: () => undefined,
  });
  await client.connect();

  await client.sendTool("bridge_reply", {
    content: "hi",
    final: true,
    messageId: "m1",
  });

  // Allow event loop to flush tool -> emit -> bridge bus.
  for (let i = 0; i < 50; i++) {
    if (events.some((e) => e.type === "agent.reply")) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  const reply = events.find((e) => e.type === "agent.reply");
  expect(reply).toBeDefined();
  if (reply && reply.type === "agent.reply") {
    expect(reply.content).toBe("hi");
    expect(reply.final).toBe(true);
    expect(reply.messageId).toBe("m1");
    expect(reply.sessionId).toBe(bridgeSessionId);
  }

  await client.close();
  ac.abort();
  await runPromise;
});

test("runServe prints channel-server connect and disconnect status to stderr", async () => {
  const ac = new AbortController();
  const stderrLines: string[] = [];
  const ready = Promise.withResolvers<{ endpoint: string }>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onReady: (info) => {
      ready.resolve({ endpoint: info.endpoint });
    },
    stdout: () => undefined,
    stderr: (line) => {
      stderrLines.push(line);
    },
  });

  const { endpoint } = await ready.promise;

  const client = new ControlClient({ endpoint, sessionId: TEST_UUID, onDeliver: () => undefined });
  await client.connect();

  for (let i = 0; i < 50; i++) {
    if (stderrLines.some((l) => l.includes("channel server connected"))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(stderrLines.join("")).toContain(`channel server connected; session ${TEST_UUID} is live`);

  await client.close();
  for (let i = 0; i < 50; i++) {
    if (stderrLines.some((l) => l.includes("channel server disconnected"))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(stderrLines.join("")).toContain(`channel server disconnected (session ${TEST_UUID})`);

  ac.abort();
  await runPromise;
});

test("runServe.inject delivers user messages to the connected channel client", async () => {
  const ac = new AbortController();
  const ready = Promise.withResolvers<{
    endpoint: string;
    inject: (text: string) => Promise<string>;
  }>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onReady: (info) => {
      ready.resolve({ endpoint: info.endpoint, inject: info.inject });
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });

  const { endpoint, inject } = await ready.promise;

  const delivered: string[] = [];
  const deliverWaiter = Promise.withResolvers<void>();
  const client = new ControlClient({
    endpoint,
    sessionId: TEST_UUID,
    onDeliver: (content) => {
      delivered.push(content);
      deliverWaiter.resolve();
    },
  });
  await client.connect();

  const messageId = await inject("ping");
  expect(messageId.length).toBeGreaterThan(0);

  await deliverWaiter.promise;
  expect(delivered).toEqual(["ping"]);

  await client.close();
  ac.abort();
  await runPromise;
});

test("runServe shuts down cleanly when the abort signal fires", async () => {
  const ac = new AbortController();
  const ready = Promise.withResolvers<void>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onReady: () => {
      ready.resolve();
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });

  await ready.promise;
  ac.abort();
  // Should resolve without throwing; if it hangs the test times out.
  await runPromise;
});

test("runServe prints bridge_uuid and jsonl path to stderr at startup", async () => {
  const ac = new AbortController();
  const stderrLines: string[] = [];
  const ready = Promise.withResolvers<void>();
  const mcpConfigPath = join(tmpdir(), `ccb-serve-${TEST_UUID}.mcp.json`);

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onReady: () => {
      ready.resolve();
    },
    stdout: () => undefined,
    stderr: (line) => {
      stderrLines.push(line);
    },
  });

  await ready.promise;

  // The per-session mcp-config exists during the run and is removed on shutdown.
  await access(mcpConfigPath);

  ac.abort();
  await runPromise;

  const joined = stderrLines.join("");
  expect(joined).toMatch(/listening on 127\.0\.0\.1:\d+/);
  expect(joined).toMatch(/bridge_uuid: [0-9a-f-]{36}/i);
  expect(joined).toContain(`jsonl: ${storeDir}/`);
  expect(joined).toContain(".jsonl");
  // The paste-ready second-terminal command loads the channel from the plain
  // `ccb` server defined in the generated --mcp-config.
  expect(joined).toContain("claude --dangerously-load-development-channels server:ccb");
  expect(joined).toContain(`--mcp-config ${mcpConfigPath}`);
  expect(joined).toContain('--allowed-tools "mcp__ccb__bridge_reply');

  // The mcp-config file is cleaned up after shutdown.
  await expect(access(mcpConfigPath)).rejects.toThrow();
});

test("runServe synthesizes channel-disconnect event pair when the channel peer socket closes", async () => {
  const ac = new AbortController();
  const events: BridgeEvent[] = [];
  const ready = Promise.withResolvers<{ endpoint: string }>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onEvent: (ev) => {
      events.push(ev);
    },
    onReady: (info) => {
      ready.resolve({ endpoint: info.endpoint });
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });

  const { endpoint } = await ready.promise;

  const client = new ControlClient({
    endpoint,
    sessionId: TEST_UUID,
    onDeliver: () => undefined,
  });
  await client.connect();

  // Force-close the peer socket from the channel-server side, simulating a
  // channel-server crash (kill -9). The supervisor must detect the
  // disconnect and synthesize the crash event pair.
  await client.close();

  // Wait for the synthesized session.ended.
  for (let i = 0; i < 200; i++) {
    if (events.some((e) => e.type === "session.ended")) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  const done = events.find((e) => e.type === "agent.done" && e.reason === "channel-disconnected");
  // A peer disconnect is not a crash from this supervisor's vantage point; the
  // session.ended reason must be the neutral "channel disconnected".
  const ended = events.find(
    (e) => e.type === "session.ended" && e.reason === "channel disconnected",
  );
  expect(done).toBeDefined();
  expect(ended).toBeDefined();
  // Ordering: agent.done lands before session.ended.
  const doneIdx = events.findIndex(
    (e) => e.type === "agent.done" && e.reason === "channel-disconnected",
  );
  const endedIdx = events.findIndex(
    (e) => e.type === "session.ended" && e.reason === "channel disconnected",
  );
  expect(endedIdx).toBeGreaterThan(doneIdx);

  // The peer-close synthesizes session.ended, which must tear runServe down on
  // its own without an abort signal.
  ac.abort();
  await runPromise;
});

test("runServe resolves on peer disconnect without an abort signal", async () => {
  const ready = Promise.withResolvers<{ endpoint: string }>();

  // Deliberately omit `signal`: the only thing that should unblock runServe is
  // the synthesized session.ended from the peer disconnect.
  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    onReady: (info) => {
      ready.resolve({ endpoint: info.endpoint });
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });

  const { endpoint } = await ready.promise;

  const client = new ControlClient({
    endpoint,
    sessionId: TEST_UUID,
    onDeliver: () => undefined,
  });
  await client.connect();
  await client.close();

  // Timeout guard: a regression that hangs after session.ended must fail loudly
  // rather than stall the whole run.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("runServe did not resolve after peer disconnect")), 3000),
  );
  await Promise.race([runPromise, timeout]);
});

test("runServe writes session.ended to stdout on abort (Ctrl-C style)", async () => {
  const ac = new AbortController();
  const lines: string[] = [];
  const ready = Promise.withResolvers<void>();

  const runPromise = runServe({
    endpoint: "127.0.0.1:0",
    sessionId: TEST_UUID,
    storeDir,
    format: "pretty",
    signal: ac.signal,
    onReady: () => {
      ready.resolve();
    },
    stdout: (line) => {
      lines.push(line);
    },
    stderr: () => undefined,
  });

  await ready.promise;
  ac.abort();
  await runPromise;

  // Last stdout line should be the session.ended marker.
  const last = lines.at(-1) ?? "";
  expect(last).toContain("[session.ended]");
});
