import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bridge,
  type BridgeEvent,
  CRASH_AGENT_DONE_REASON,
  CRASH_SESSION_ENDED_REASON,
  type SupervisorContext,
} from "@ccb/core";
import type { KillOpts, LauncherHandle, LaunchOpts } from "@ccb/process";
import { ClaudeCodeSupervisor } from "./claude-supervisor.ts";

/**
 * Fake launcher under test control. Captures the (command, args, opts) the
 * supervisor invokes `launch` with, exposes hooks for the test to drive
 * `onData` chunks (so we can simulate the dev-channels confirm hint), and
 * gates `waitExit` until the test resolves it. Mirrors enough of
 * `LauncherHandle` to satisfy the supervisor's contract.
 */
interface FakeLauncher extends LauncherHandle {
  readonly command: string;
  readonly args: readonly string[];
  readonly opts: LaunchOpts | undefined;
  readonly writes: string[];
  readonly kills: Array<{ mode: "graceful" | "signal"; opts?: KillOpts }>;
  readonly signals: NodeJS.Signals[];
  emitData(chunk: string): void;
  resolveExit(exit?: { code: number; signal?: string }): void;
}

function makeFakeLauncher(
  command: string,
  args: readonly string[],
  opts?: LaunchOpts,
): FakeLauncher {
  const writes: string[] = [];
  const kills: Array<{ mode: "graceful" | "signal"; opts?: KillOpts }> = [];
  const signals: NodeJS.Signals[] = [];
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(e: { code: number; signal?: string }) => void>();
  let exit: { code: number; signal?: string } | undefined;
  const exitWaiters: Array<(e: { code: number; signal?: string }) => void> = [];

  const fake: FakeLauncher = {
    command,
    args,
    opts,
    writes,
    kills,
    signals,
    pid: 4242,
    write(data) {
      writes.push(data);
    },
    sendSignal(signal) {
      signals.push(signal);
    },
    async kill(mode, killOpts) {
      kills.push({ mode, opts: killOpts });
      if (killOpts?.gracefulInput) {
        writes.push(killOpts.gracefulInput);
      }
      // The supervisor relies on kill's promise resolving once the launcher's
      // own escalation ladder finishes. Resolve immediately and synthesize an
      // exit so waitExit unblocks.
      if (!exit) {
        exit = { code: 0 };
        for (const cb of exitListeners) cb(exit);
        for (const w of exitWaiters.splice(0)) w(exit);
      }
    },
    waitExit() {
      if (exit) return Promise.resolve(exit);
      return new Promise((resolve) => {
        exitWaiters.push(resolve);
      });
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit(cb) {
      if (exit) {
        cb(exit);
        return () => undefined;
      }
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
    emitData(chunk) {
      for (const cb of dataListeners) cb(chunk);
    },
    resolveExit(e) {
      if (exit) return;
      exit = e ?? { code: 0 };
      for (const cb of exitListeners) cb(exit);
      for (const w of exitWaiters.splice(0)) w(exit);
    },
  };
  return fake;
}

let storeDir: string;
const liveLaunchers: FakeLauncher[] = [];

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-claude-supervisor-"));
  liveLaunchers.length = 0;
});

afterEach(async () => {
  for (const f of liveLaunchers) {
    f.resolveExit({ code: 0 });
  }
  await rm(storeDir, { recursive: true, force: true });
});

function captureLauncherFactory(): (
  cmd: string,
  args: readonly string[],
  opts?: LaunchOpts,
) => FakeLauncher {
  return (cmd, args, opts) => {
    const f = makeFakeLauncher(cmd, args, opts);
    liveLaunchers.push(f);
    return f;
  };
}

const FAKE_SESSION_ID = "00000000-0000-0000-0000-0000000000aa";

async function startWithFakeLauncher(opts: {
  channels?: "dev-flag" | "plugin";
  autoConfirmTimeoutMs?: number;
  startTimeoutMs?: number;
}): Promise<{
  supervisor: ClaudeCodeSupervisor;
  ctx: SupervisorContext;
  emitted: BridgeEvent[];
  launcher: FakeLauncher;
  startResult: Promise<void>;
}> {
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({
    channels: opts.channels ?? "dev-flag",
    autoConfirmTimeoutMs: opts.autoConfirmTimeoutMs,
    startTimeoutMs: opts.startTimeoutMs,
    launcherFactory: factory,
  });
  const emitted: BridgeEvent[] = [];
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: (event) => {
      emitted.push(event);
    },
  };
  // Drive start to completion so the launcher has been constructed.
  const startResult = supervisor.start(ctx);
  await startResult;
  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher was not created");
  return { supervisor, ctx, emitted, launcher, startResult };
}

test("start in dev-flag mode launches claude with the documented flag set", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  expect(launcher.command).toBe("claude");
  const args = [...launcher.args];
  expect(args).toContain("--dangerously-load-development-channels");
  // The value follows the flag.
  const idx = args.indexOf("--dangerously-load-development-channels");
  expect(args[idx + 1]).toBe("server:ccb");
  expect(args).toContain("--mcp-config");
  expect(args).toContain("--add-dir");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--allowed-tools");
  const toolsIdx = args.indexOf("--allowed-tools");
  expect(args[toolsIdx + 1]).toBe(
    "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done",
  );
  // The plugin flag must NOT appear in dev-flag mode.
  expect(args).not.toContain("--channels");
  await supervisor.close(FAKE_SESSION_ID);
});

test("start in plugin mode replaces the dev flag with --channels plugin:ccb@ccb-local", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).not.toContain("--dangerously-load-development-channels");
  expect(args).toContain("--channels");
  const idx = args.indexOf("--channels");
  expect(args[idx + 1]).toBe("plugin:ccb@ccb-local");
  await supervisor.close(FAKE_SESSION_ID);
});

test("--mcp-config points at a temp .mcp.json file with absolute Bun + bin.ts paths", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({});
  await startResult;
  const args = [...launcher.args];
  const cfgIdx = args.indexOf("--mcp-config");
  const cfgPath = args[cfgIdx + 1];
  expect(typeof cfgPath).toBe("string");
  if (!cfgPath) throw new Error("missing --mcp-config value");
  const exists = await stat(cfgPath).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(true);
  const json = JSON.parse(await readFile(cfgPath, "utf8")) as {
    mcpServers: {
      ccb: {
        command: string;
        args: string[];
        env: { CCB_BRIDGE_ENDPOINT: string; CCB_SESSION_ID: string };
      };
    };
  };
  // process.execPath is the running Bun binary; managed launch passes that
  // verbatim so the channel server is not subject to PATH ambiguity.
  expect(json.mcpServers.ccb.command).toBe(process.execPath);
  expect(json.mcpServers.ccb.args[0]).toMatch(/packages\/mcp-channel\/src\/bin\.ts$/);
  expect(json.mcpServers.ccb.env.CCB_SESSION_ID).toBe(FAKE_SESSION_ID);
  expect(json.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT).toMatch(/^127\.0\.0\.1:\d+$/);
  await supervisor.close(FAKE_SESSION_ID);
  // Temp file is cleaned up on close.
  const stillThere = await stat(cfgPath).then(
    () => true,
    () => false,
  );
  expect(stillThere).toBe(false);
});

test("auto-confirm: dev-flag mode writes \\n after the 'Press Enter to continue' hint", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  // Simulate claude printing the dev-channels warning ahead of the confirm
  // prompt; the supervisor's scanner should fire after the hint substring
  // appears.
  launcher.emitData("Loading development channels: server:ccb\r\n");
  launcher.emitData("Press Enter to continue or Ctrl-C to abort.\r\n");
  // Let the microtask queue flush.
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\n");
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: plugin mode never writes \\n even if the hint appears", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  launcher.emitData("Press Enter to continue or Ctrl-C to abort.\r\n");
  await new Promise((r) => setTimeout(r, 10));
  // Plugin mode does not subscribe an auto-confirm scanner; no Enter sent.
  expect(launcher.writes).not.toContain("\n");
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: scan times out cleanly when the hint never appears", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmTimeoutMs: 30,
  });
  await startResult;
  // Emit some output that doesn't match the hint.
  launcher.emitData("some unrelated banner\r\n");
  await new Promise((r) => setTimeout(r, 80));
  expect(launcher.writes).not.toContain("\n");
  await supervisor.close(FAKE_SESSION_ID);
});

test("sendMessage forwards through the control server, not the PTY", async () => {
  // Drive the supervisor through a Bridge so we can use the real
  // ControlServer.deliver path. Build a channel-server-like client that
  // connects to the supervisor's ControlServer and asserts the deliver was
  // received over the wire.
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
  });
  const emitted: BridgeEvent[] = [];
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: (event) => {
      emitted.push(event);
    },
  };
  await supervisor.start(ctx);
  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher missing");

  // Read the mcp-config to grab the endpoint the supervisor bound to.
  const args = [...launcher.args];
  const cfgIdx = args.indexOf("--mcp-config");
  const cfgPath = args[cfgIdx + 1];
  if (!cfgPath) throw new Error("missing --mcp-config value");
  const json = JSON.parse(await readFile(cfgPath, "utf8")) as {
    mcpServers: { ccb: { env: { CCB_BRIDGE_ENDPOINT: string } } };
  };
  const endpoint = json.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT;

  const { ControlClient } = await import("@ccb/mcp-channel");
  const delivered: Array<{ content: string; messageId?: string }> = [];
  const client = new ControlClient({
    endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: async (content, opts) => {
      delivered.push({ content, ...(opts.messageId ? { messageId: opts.messageId } : {}) });
    },
  });
  await client.connect();

  await supervisor.sendMessage(FAKE_SESSION_ID, "m1", "hello over the wire");
  // Give the client's read loop a turn.
  await new Promise((r) => setTimeout(r, 20));

  expect(delivered).toEqual([{ content: "hello over the wire", messageId: "m1" }]);
  // The PTY must not have been written to (no message bytes there).
  expect(launcher.writes).not.toContain("hello over the wire");

  await client.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("interrupt delivers a single SIGINT to the launcher (no SIGTERM)", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({});
  await startResult;
  await supervisor.interrupt(FAKE_SESSION_ID);
  expect(launcher.signals).toEqual(["SIGINT"]);
  // interrupt must not trigger any kill ladder.
  expect(launcher.kills).toEqual([]);
  await supervisor.close(FAKE_SESSION_ID);
});

test("close drives the teardown ladder via launcher.kill('graceful',{gracefulInput:'/exit\\n'})", async () => {
  const { supervisor, launcher, startResult } = await startWithFakeLauncher({});
  await startResult;
  await supervisor.close(FAKE_SESSION_ID);
  expect(launcher.kills.length).toBe(1);
  const k = launcher.kills[0];
  if (!k) throw new Error("expected one kill");
  expect(k.mode).toBe("graceful");
  expect(k.opts?.gracefulInput).toBe("/exit\n");
});

test("failed start: cleans up the temp .mcp.json file when launch throws", async () => {
  let capturedPath: string | undefined;
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: (_cmd, args) => {
      const idx = args.indexOf("--mcp-config");
      capturedPath = args[idx + 1];
      throw new Error("simulated launch failure");
    },
  });
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  await expect(supervisor.start(ctx)).rejects.toThrow(/simulated launch failure/);
  if (!capturedPath) throw new Error("path was not captured");
  const exists = await stat(capturedPath).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(false);
});

test("integrates with Bridge: agent.reply lands when control client invokes bridge_reply", async () => {
  // Drive a full Bridge.startSession via a factory so we own the supervisor.
  let captured: ClaudeCodeSupervisor | undefined;
  const factory = captureLauncherFactory();
  const bridge = new Bridge({
    storeDir,
    supervisorFactory: () => {
      const sup = new ClaudeCodeSupervisor({
        channels: "dev-flag",
        launcherFactory: factory,
      });
      captured = sup;
      return sup;
    },
  });
  const { id } = await bridge.startSession({});
  if (!captured) throw new Error("supervisor was not created");

  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher missing");
  const args = [...launcher.args];
  const cfgIdx = args.indexOf("--mcp-config");
  const cfgPath = args[cfgIdx + 1];
  if (!cfgPath) throw new Error("missing --mcp-config value");
  const json = JSON.parse(await readFile(cfgPath, "utf8")) as {
    mcpServers: { ccb: { env: { CCB_BRIDGE_ENDPOINT: string } } };
  };
  const endpoint = json.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT;

  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint,
    sessionId: id,
    onDeliver: async () => {
      // Drop incoming user messages; the bridge does not need them echoed.
    },
  });
  await client.connect();

  // Simulate the agent invoking bridge_reply from the channel server side.
  await client.sendTool("bridge_reply", {
    content: "hi from fake claude",
    final: true,
  });
  // Let the read loop flush.
  await new Promise((r) => setTimeout(r, 30));

  const stored = await bridge.readStoredEvents(id);
  const reply = stored.find((e) => e.type === "agent.reply");
  if (reply?.type !== "agent.reply") throw new Error("expected agent.reply");
  expect(reply.content).toBe("hi from fake claude");
  expect(reply.final).toBe(true);

  await client.close();
  await bridge.close(id);
});

test("peer-close: synthesizes crash event pair when the channel client drops", async () => {
  // Drive the supervisor through a Bridge so the bridge consumes the emitted
  // crash events and writes them to the store / live event stream.
  const factory = captureLauncherFactory();
  const bridge = new Bridge({
    storeDir,
    supervisorFactory: () =>
      new ClaudeCodeSupervisor({
        channels: "dev-flag",
        launcherFactory: factory,
      }),
  });
  const { id } = await bridge.startSession({});

  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher missing");
  const args = [...launcher.args];
  const cfgIdx = args.indexOf("--mcp-config");
  const cfgPath = args[cfgIdx + 1];
  if (!cfgPath) throw new Error("missing --mcp-config value");
  const json = JSON.parse(await readFile(cfgPath, "utf8")) as {
    mcpServers: { ccb: { env: { CCB_BRIDGE_ENDPOINT: string } } };
  };
  const endpoint = json.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT;

  // Subscribe to the live event stream so we can assert it terminates cleanly.
  const liveEvents: BridgeEvent[] = [];
  const readerDone = (async () => {
    for await (const ev of bridge.events(id)) {
      liveEvents.push(ev);
      if (ev.type === "session.ended") break;
    }
  })();

  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint,
    sessionId: id,
    onDeliver: () => undefined,
  });
  await client.connect();

  // Simulate the channel-server peer dropping its socket (kill -9 / crash).
  await client.close();

  // The reader terminates on session.ended; bounded wait so a regression
  // surfaces as a timeout failure rather than a hang.
  await Promise.race([
    readerDone,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("reader did not terminate")), 2000),
    ),
  ]);

  const done = liveEvents.find(
    (e) => e.type === "agent.done" && e.reason === CRASH_AGENT_DONE_REASON,
  );
  const ended = liveEvents.find(
    (e) => e.type === "session.ended" && e.reason === CRASH_SESSION_ENDED_REASON,
  );
  expect(done).toBeDefined();
  expect(ended).toBeDefined();
  // agent.done must precede session.ended.
  const doneIdx = liveEvents.findIndex(
    (e) => e.type === "agent.done" && e.reason === CRASH_AGENT_DONE_REASON,
  );
  const endedIdx = liveEvents.findIndex(
    (e) => e.type === "session.ended" && e.reason === CRASH_SESSION_ENDED_REASON,
  );
  expect(endedIdx).toBeGreaterThan(doneIdx);

  // Bridge already tore the session down via the supervisor-emitted
  // session.ended; close is a no-op for this session id.
});

test("cooperative close: does NOT synthesize crash events", async () => {
  const { supervisor, ctx, emitted } = await startWithFakeLauncher({});
  // Sanity: no crash events emitted at start.
  expect(emitted.some((e) => e.type === "agent.done" && e.reason === CRASH_AGENT_DONE_REASON)).toBe(
    false,
  );
  await supervisor.close(ctx.sessionId);
  // After cooperative close, the supervisor must not synthesize crash events.
  // The ControlServer's own peer-close suppression (driven by its #closing
  // flag) guarantees this; the test pins the behavior end-to-end.
  expect(emitted.some((e) => e.type === "agent.done" && e.reason === CRASH_AGENT_DONE_REASON)).toBe(
    false,
  );
  expect(
    emitted.some((e) => e.type === "session.ended" && e.reason === CRASH_SESSION_ENDED_REASON),
  ).toBe(false);
});
