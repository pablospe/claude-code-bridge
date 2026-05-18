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
import type { ControlClient } from "@ccb/mcp-channel";
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

/**
 * Bounded polling helper. Resolves as soon as `predicate()` returns truthy.
 * Rejects after `timeoutMs` so a regression surfaces as a test failure rather
 * than a hang. Used to observe state transitions on the supervisor that are
 * not directly awaitable (e.g. ControlServer bind, hello-gate clearance).
 */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: predicate did not become truthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

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
  /**
   * Real ControlClient connected to the supervisor's ControlServer; its
   * `connect()` fired the synthetic `hello` that clears the start gate.
   * Tests must close this client before closing the supervisor so the
   * cooperative-shutdown path is exercised (no peer-close crash events).
   */
  helloClient: ControlClient;
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
  // Kick off start; it now blocks on the channel-server hello.
  const startResult = supervisor.start(ctx);
  // Wait until the ControlServer has bound, then connect a real client. The
  // client's connect() sends a `hello` which clears the supervisor's gate.
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");
  const { ControlClient: ControlClientCtor } = await import("@ccb/mcp-channel");
  const helloClient = new ControlClientCtor({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await helloClient.connect();
  await startResult;
  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher was not created");
  return { supervisor, ctx, emitted, launcher, startResult, helloClient };
}

test("supervisor.start blocks until the channel server connects and says hello", async () => {
  // Closes the managed-launch race: without this gate, sendMessage races
  // ahead of the channel client and fails with "no connected client". The
  // gate makes start() resolve only after a `hello` arrives for this session.
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
  });
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  let resolved = false;
  const startPromise = supervisor
    .start(ctx)
    .then(() => {
      resolved = true;
    })
    .catch((err) => {
      throw err;
    });
  // The ControlServer has bound (server.listen returned) but no client has
  // connected yet -- start() must remain pending.
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  await new Promise((r) => setTimeout(r, 100));
  expect(resolved).toBe(false);
  // Now connect a real client; its synthetic `hello` clears the gate.
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");
  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();
  await startPromise;
  expect(resolved).toBe(true);
  await client.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("supervisor.start does not resolve on a hello with the wrong sessionId", async () => {
  // The gate is keyed on the supervisor's session id; a hello carrying any
  // other id must be ignored (and ControlServer rejects mismatched duplicate
  // sessions on its own — that is not the concern here).
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
  });
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  let resolved = false;
  const startPromise = supervisor.start(ctx).then(() => {
    resolved = true;
  });
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");
  const { ControlClient } = await import("@ccb/mcp-channel");
  // Wrong session id -- supervisor must still be waiting.
  const wrong = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    onDeliver: () => undefined,
  });
  await wrong.connect();
  await new Promise((r) => setTimeout(r, 100));
  expect(resolved).toBe(false);
  // Correct session id clears the gate.
  const right = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await right.connect();
  await startPromise;
  expect(resolved).toBe(true);
  await wrong.close();
  await right.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("Bridge.startTimeoutMs aborts a hello-less start cleanly", async () => {
  // The supervisor itself does not bound the hello wait -- the bridge does,
  // via startTimeoutMs. With no client connecting, bridge.startSession must
  // reject with StartTimeoutError and the failed-start cleanup path must run
  // (temp dir removed, no session leaked).
  const { Bridge, StartTimeoutError } = await import("@ccb/core");
  const factory = captureLauncherFactory();
  const bridge = new Bridge({
    storeDir,
    startTimeoutMs: 200,
    supervisorFactory: () =>
      new ClaudeCodeSupervisor({
        channels: "dev-flag",
        launcherFactory: factory,
      }),
  });
  await expect(bridge.startSession({})).rejects.toBeInstanceOf(StartTimeoutError);
  // Launcher was constructed before the gate; the rig's afterEach hook will
  // resolveExit() on it, but the bridge must have already torn the session
  // down -- subsequent events() for any uuid returns an empty iterable.
  expect(liveLaunchers.length).toBe(1);
});

test("serverEndpoint exposes the bound ControlServer address after start, undefined before/after", async () => {
  // Test rigs need to discover the supervisor's randomly-bound ControlServer
  // endpoint so they can connect a real ControlClient (which fires the
  // synthetic `hello` the hello-gate awaits). The getter is the seam.
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
  });
  // Before start: undefined.
  expect(supervisor.serverEndpoint).toBeUndefined();
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  const startPromise = supervisor.start(ctx);
  // The server binds before start awaits anything async after the listen()
  // call returns, but to keep this independent of internal ordering, we poll
  // briefly via the helper used elsewhere.
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");
  expect(ep.host).toBe("127.0.0.1");
  expect(ep.port).toBeGreaterThan(0);
  expect(ep.endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
  // Drive the hello so start can resolve.
  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();
  await startPromise;
  await client.close();
  await supervisor.close(FAKE_SESSION_ID);
  // After close: undefined again.
  expect(supervisor.serverEndpoint).toBeUndefined();
});

test("start in dev-flag mode launches claude with the documented flag set", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
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
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("start in plugin mode replaces the dev flag with --channels plugin:ccb@ccb-local", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).not.toContain("--dangerously-load-development-channels");
  expect(args).toContain("--channels");
  const idx = args.indexOf("--channels");
  expect(args[idx + 1]).toBe("plugin:ccb@ccb-local");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("--mcp-config points at a temp .mcp.json file with absolute Bun + bin.ts paths", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({});
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
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
  // Temp file is cleaned up on close.
  const stillThere = await stat(cfgPath).then(
    () => true,
    () => false,
  );
  expect(stillThere).toBe(false);
});

test("auto-confirm: dev-flag mode writes \\n after the 'Press Enter to continue' hint", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
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
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: plugin mode never writes \\n even if the hint appears", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  launcher.emitData("Press Enter to continue or Ctrl-C to abort.\r\n");
  await new Promise((r) => setTimeout(r, 10));
  // Plugin mode does not subscribe an auto-confirm scanner; no Enter sent.
  expect(launcher.writes).not.toContain("\n");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: scan times out cleanly when the hint never appears", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmTimeoutMs: 30,
  });
  await startResult;
  // Emit some output that doesn't match the hint.
  launcher.emitData("some unrelated banner\r\n");
  await new Promise((r) => setTimeout(r, 80));
  expect(launcher.writes).not.toContain("\n");
  await helloClient.close();
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
  // start() now blocks on the channel-server hello, so we must connect the
  // synthetic client BEFORE awaiting the promise.
  const startPromise = supervisor.start(ctx);
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher missing");
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");

  const { ControlClient } = await import("@ccb/mcp-channel");
  const delivered: Array<{ content: string; messageId?: string }> = [];
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: async (content, opts) => {
      delivered.push({ content, ...(opts.messageId ? { messageId: opts.messageId } : {}) });
    },
  });
  await client.connect();
  await startPromise;

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
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({});
  await startResult;
  await supervisor.interrupt(FAKE_SESSION_ID);
  expect(launcher.signals).toEqual(["SIGINT"]);
  // interrupt must not trigger any kill ladder.
  expect(launcher.kills).toEqual([]);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("close drives the teardown ladder via launcher.kill('graceful',{gracefulInput:'/exit\\n'})", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({});
  await startResult;
  await helloClient.close();
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

test("auto-confirm: sliding window keeps the hint detectable after a noisy boot", async () => {
  // Feed ~50KB of garbage that does not contain the hint substring, then
  // emit the hint at the very end. Proves the buffer is bounded (no OOM /
  // unbounded growth) yet still preserves enough trailing context to match
  // the hint when it finally appears.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  const garbage = "x".repeat(1024);
  for (let i = 0; i < 50; i++) {
    launcher.emitData(garbage);
  }
  launcher.emitData("Press Enter to continue or Ctrl-C to abort.\r\n");
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\n");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: hint split across two chunks is still detected after garbage", async () => {
  // After a noisy boot, the hint substring may arrive split across two PTY
  // chunks. The sliding window must retain enough trailing context that the
  // first half is still in the buffer when the second half arrives.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  const garbage = "x".repeat(1024);
  for (let i = 0; i < 50; i++) {
    launcher.emitData(garbage);
  }
  launcher.emitData("Press Enter to ");
  launcher.emitData("continue or Ctrl-C to abort.\r\n");
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\n");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("failed start: cleans up the temp dir when writeFile throws after mkdtemp", async () => {
  // Inject a writeFile that throws to simulate the disk-full / EACCES path.
  // The supervisor must still rm the temp dir created by mkdtemp before
  // re-throwing, so the failure does not orphan the dir under tmpdir().
  const factory = captureLauncherFactory();
  let capturedDir: string | undefined;
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
    writeFile: async (path) => {
      // The path is <tempDir>/mcp.json — capture the parent dir for the
      // post-rejection existence check.
      capturedDir = join(path.toString(), "..");
      throw new Error("EACCES: writeFile failed");
    },
  });
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  await expect(supervisor.start(ctx)).rejects.toThrow(/EACCES: writeFile failed/);
  if (!capturedDir) throw new Error("temp dir path was not captured");
  const exists = await stat(capturedDir).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(false);
  // The launcher must not have been constructed.
  expect(liveLaunchers.length).toBe(0);
});

test("integrates with Bridge: agent.reply lands when control client invokes bridge_reply", async () => {
  // Drive a full Bridge.startSession via a factory so we own the supervisor.
  let captured: ClaudeCodeSupervisor | undefined;
  let sessionId: string | undefined;
  const factory = captureLauncherFactory();
  const bridge = new Bridge({
    storeDir,
    supervisorFactory: (id) => {
      sessionId = id;
      const sup = new ClaudeCodeSupervisor({
        channels: "dev-flag",
        launcherFactory: factory,
      });
      captured = sup;
      return sup;
    },
  });
  // startSession now blocks until the channel-server hello arrives. Spawn it
  // and connect a synthetic client while it is in flight.
  const startSessionPromise = bridge.startSession({});
  await waitFor(() => captured?.serverEndpoint !== undefined);
  if (!captured) throw new Error("supervisor was not created");
  if (!sessionId) throw new Error("sessionId not captured");
  const ep = captured.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");

  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId,
    onDeliver: async () => {
      // Drop incoming user messages; the bridge does not need them echoed.
    },
  });
  await client.connect();
  const { id } = await startSessionPromise;

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
  let captured: ClaudeCodeSupervisor | undefined;
  let sessionId: string | undefined;
  const factory = captureLauncherFactory();
  const bridge = new Bridge({
    storeDir,
    supervisorFactory: (id) => {
      sessionId = id;
      const sup = new ClaudeCodeSupervisor({
        channels: "dev-flag",
        launcherFactory: factory,
      });
      captured = sup;
      return sup;
    },
  });
  // startSession blocks on hello; connect the client mid-flight.
  const startSessionPromise = bridge.startSession({});
  await waitFor(() => captured?.serverEndpoint !== undefined);
  if (!captured || !sessionId) throw new Error("supervisor/session not captured");
  const ep = captured.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");

  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId,
    onDeliver: () => undefined,
  });
  await client.connect();
  const { id } = await startSessionPromise;

  // Subscribe to the live event stream so we can assert it terminates cleanly.
  const liveEvents: BridgeEvent[] = [];
  const readerDone = (async () => {
    for await (const ev of bridge.events(id)) {
      liveEvents.push(ev);
      if (ev.type === "session.ended") break;
    }
  })();

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
  const { supervisor, ctx, emitted, helloClient } = await startWithFakeLauncher({});
  // Sanity: no crash events emitted at start.
  expect(emitted.some((e) => e.type === "agent.done" && e.reason === CRASH_AGENT_DONE_REASON)).toBe(
    false,
  );
  // Close the synthetic client first so the supervisor.close path is the
  // cooperative shutdown (not a peer-close driven by an orphaned client).
  await helloClient.close();
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
