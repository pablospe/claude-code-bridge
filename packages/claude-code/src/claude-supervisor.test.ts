import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  autoConfirmInitialDelayMs?: number;
  autoConfirmRetryIntervalMs?: number;
  autoConfirmMaxAttempts?: number;
  hooks?: { events: ReadonlyArray<"PreToolUse" | "PostToolUse" | "Stop"> };
  cleanSession?: boolean;
  rawModel?: boolean;
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
    autoConfirmInitialDelayMs: opts.autoConfirmInitialDelayMs,
    autoConfirmRetryIntervalMs: opts.autoConfirmRetryIntervalMs,
    autoConfirmMaxAttempts: opts.autoConfirmMaxAttempts,
    hooks: opts.hooks,
    cleanSession: opts.cleanSession,
    rawModel: opts.rawModel,
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

test("supervisor.start does not lose a hello that arrives while config files are written", async () => {
  // Boot race regression test: serverEndpoint becomes visible before start()
  // finishes its async config writes. A client that connects in that window
  // sends its hello before the start gate exists; the gate must still clear.
  // The injected writeFile parks start() inside the window until the hello
  // has been sent.
  const factory = captureLauncherFactory();
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((r) => {
    releaseWrite = r;
  });
  const supervisor = new ClaudeCodeSupervisor({
    channels: "dev-flag",
    launcherFactory: factory,
    writeFile: async (...args) => {
      await writeGate;
      return writeFile(...(args as Parameters<typeof writeFile>));
    },
  });
  const ctx: SupervisorContext = {
    sessionId: FAKE_SESSION_ID,
    emit: () => {},
  };
  const startResult = supervisor.start(ctx);
  await waitFor(() => supervisor.serverEndpoint !== undefined);
  const ep = supervisor.serverEndpoint;
  if (!ep) throw new Error("serverEndpoint not set");
  const { ControlClient } = await import("@ccb/mcp-channel");
  const client = new ControlClient({
    endpoint: ep.endpoint,
    sessionId: FAKE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();
  // Give the hello time to be fully processed by the ControlServer while
  // start() is still parked in writeFile.
  await new Promise((r) => setTimeout(r, 100));
  releaseWrite();
  await Promise.race([
    startResult,
    new Promise((_, rejectRace) =>
      setTimeout(() => rejectRace(new Error("start() never resolved: hello was lost")), 3000),
    ),
  ]);
  await client.close();
  await supervisor.close(FAKE_SESSION_ID);
}, 20_000);

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

test("start() rejects fast when claude exits before the channel hello", async () => {
  // Regression: the hello-gate used to end only on `hello`, so a claude that
  // died during boot (bad flag, crash, unconfirmed dev-channels gate) left
  // start() blocked for the full Bridge.startTimeoutMs. start() must observe
  // launcher.onExit and reject immediately with a precise error instead.
  const factory = captureLauncherFactory();
  const supervisor = new ClaudeCodeSupervisor({ channels: "dev-flag", launcherFactory: factory });
  const ctx: SupervisorContext = { sessionId: FAKE_SESSION_ID, emit: () => {} };
  const startPromise = supervisor.start(ctx);
  // No ControlClient connects (no hello). Once the launcher exists, simulate
  // claude exiting mid-boot.
  await waitFor(() => liveLaunchers.length === 1);
  const launcher = liveLaunchers[0];
  if (!launcher) throw new Error("launcher was not created");
  launcher.resolveExit({ code: 1, signal: "SIGTERM" });
  await expect(startPromise).rejects.toThrow(/exited during boot before the channel connected/);
  await supervisor.close(FAKE_SESSION_ID);
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
  // Boot-trimming flags: skip the user-tier config + slash commands.
  expect(args).toContain("--setting-sources");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(args).toContain("--disable-slash-commands");
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

test("start in plugin mode replaces the dev flag with --channels plugin:ccb@claude-code-bridge", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).not.toContain("--dangerously-load-development-channels");
  expect(args).toContain("--channels");
  const idx = args.indexOf("--channels");
  expect(args[idx + 1]).toBe("plugin:ccb@claude-code-bridge");
  // Plugin mode resolves the ccb plugin through the user-tier marketplace, so
  // the dev-flag boot-trimming flags must NOT appear here (they'd break it).
  expect(args).not.toContain("--setting-sources");
  expect(args).not.toContain("--disable-slash-commands");
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

test("auto-confirm: dev-flag mode writes \\r after the 'Enter to confirm' hint", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  // Simulate claude printing the dev-channels warning ahead of the confirm
  // prompt; the supervisor's scanner should fire after the hint substring
  // appears.
  launcher.emitData("Loading development channels: server:ccb\r\n");
  launcher.emitData("Enter to confirm · Esc to cancel\r\n");
  // Let the microtask queue flush.
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\r");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: hint substring matches even when claude renders ANSI CSI codes between words", async () => {
  // Claude's actual PTY output replaces every space between words in the
  // dev-channels warning with the CSI sequence `[1C` (cursor-forward-1).
  // A naive substring scanner would never match this; the supervisor
  // strips ANSI sequences before matching, so this test feeds the
  // wire-form bytes and asserts the scanner still fires.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    // Push the blind fallback far enough out that this test only succeeds
    // via the ANSI-aware scanner path, not the blind retry.
    autoConfirmInitialDelayMs: 5_000,
    autoConfirmRetryIntervalMs: 5_000,
  });
  await startResult;
  // Verbatim slice of what claude 2.1.143 prints (each word break is a
  // CSI cursor-forward, not a literal space).
  launcher.emitData(
    "\x1b[2C\x1b[38;5;246m\x1b[3mEnter\x1b[1Cto\x1b[1Cconfirm\x1b[1C·\x1b[1CEsc\x1b[1Cto\x1b[1Ccancel\x1b[23m\x1b[39m\r\n",
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(launcher.writes).toContain("\r");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: hint matches when claude spaces words with absolute-column CSI codes", async () => {
  // Verbatim form claude 2.1.146 actually emits: words separated by absolute
  // column moves (`\x1b[9G`, `\x1b[12G`), NOT cursor-forward. normalizePty
  // deletes these, so the rendered hint arrives as "Entertoconfirm" — the
  // whitespace-insensitive compare is what makes the fast-path fire here.
  // Blind fallback pushed far out so only the scanner path can satisfy this.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmInitialDelayMs: 5_000,
    autoConfirmRetryIntervalMs: 5_000,
  });
  await startResult;
  launcher.emitData(
    "\x1b[3G\x1b[38;5;246m\x1b[3mEnter\x1b[9Gto\x1b[12Gconfirm\x1b[20G·\x1b[22GEsc\x1b[26Gto\x1b[29Gcancel\x1b[23m\x1b[39m\r\n",
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(launcher.writes).toContain("\r");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: plugin mode never writes \\n even if the hint appears", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "plugin",
  });
  await startResult;
  launcher.emitData("Enter to confirm · Esc to cancel\r\n");
  await new Promise((r) => setTimeout(r, 10));
  // Plugin mode does not subscribe an auto-confirm scanner; no Enter sent.
  expect(launcher.writes).not.toContain("\r");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: writes \\r repeatedly at the retry interval when the hint never appears", async () => {
  // The fallback covers runtimes where PTY onData callbacks do not fire
  // (e.g. Bun's NAPI gap for node-pty at the time of writing) AND the
  // slow-boot case (onData works but claude isn't ready to consume the first
  // \r). A single blind shot is racy; the supervisor retries at a bounded
  // interval. The risk of misfire is bounded: each stray \r submits an empty
  // turn — no data loss, no crash.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmInitialDelayMs: 20,
    autoConfirmRetryIntervalMs: 20,
    autoConfirmMaxAttempts: 4,
  });
  await startResult;
  // Emit some output that doesn't match the hint.
  launcher.emitData("some unrelated banner\r\n");
  // Wait long enough for ~3 attempts (initial + 2 retries) to fire.
  await new Promise((r) => setTimeout(r, 80));
  const crWrites = launcher.writes.filter((w) => w === "\r");
  expect(crWrites.length).toBeGreaterThanOrEqual(3);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: writes \\r up to maxAttempts times then stops", async () => {
  // The retry loop is bounded by autoConfirmMaxAttempts so a pathological
  // boot does not produce an unbounded stream of stray empty turns. The outer
  // bound is Bridge.startTimeoutMs; this is the inner bound.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmInitialDelayMs: 10,
    autoConfirmRetryIntervalMs: 10,
    autoConfirmMaxAttempts: 3,
  });
  await startResult;
  launcher.emitData("unrelated\r\n");
  // Wait well past what would be 6 attempts at 10ms each (~60ms).
  await new Promise((r) => setTimeout(r, 150));
  const crWrites = launcher.writes.filter((w) => w === "\r");
  expect(crWrites.length).toBe(3);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("auto-confirm: fast-path hint detection cancels the retry interval", async () => {
  // When the onData hint fires, the scanner writes a single \r and cancels
  // the retry interval. Otherwise the boot would receive both a hint-driven
  // \r AND a fallback \r at the next retry boundary.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    autoConfirmInitialDelayMs: 50,
    autoConfirmRetryIntervalMs: 20,
    autoConfirmMaxAttempts: 6,
  });
  await startResult;
  // Emit the hint immediately, before the first blind \r would fire.
  launcher.emitData("Enter to confirm · Esc to cancel\r\n");
  // Wait long enough that several retries would have fired if not cancelled.
  await new Promise((r) => setTimeout(r, 150));
  const crWrites = launcher.writes.filter((w) => w === "\r");
  expect(crWrites.length).toBe(1);
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
  launcher.emitData("Enter to confirm · Esc to cancel\r\n");
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\r");
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
  launcher.emitData("Enter to ");
  launcher.emitData("confirm · Esc to cancel\r\n");
  await new Promise((r) => setTimeout(r, 10));
  expect(launcher.writes).toContain("\r");
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

// 20s budget: supervisor.close() has an internal 5s graceful-shutdown timeout,
// so under full-suite parallel load this test can exceed bun's 5s default.
test("hooks option: writes a temp settings.json and passes its path via --settings", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    hooks: { events: ["PreToolUse", "PostToolUse", "Stop"] },
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).toContain("--settings");
  const idx = args.indexOf("--settings");
  const settingsPath = args[idx + 1];
  if (!settingsPath) throw new Error("missing --settings value");
  const exists = await stat(settingsPath).then(
    () => true,
    () => false,
  );
  expect(exists).toBe(true);
  const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  };
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
  // The managed launch wires the relay through process.execPath + absolute
  // hook-relay.ts path so PATH lookups never enter the picture for the bin.
  const preCmd = parsed.hooks.PreToolUse?.[0]?.hooks[0]?.command;
  expect(preCmd).toContain(process.execPath);
  expect(preCmd).toMatch(/packages\/mcp-channel\/src\/hook-relay\.ts PreToolUse$/);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
  // settings.json is cleaned up alongside the supervisor's temp dir on close.
  const stillThere = await stat(settingsPath).then(
    () => true,
    () => false,
  );
  expect(stillThere).toBe(false);
}, 20_000);

test("hooks option: --settings is omitted when hooks option is not set", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  expect([...launcher.args]).not.toContain("--settings");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("hooks option: only the requested events appear in settings.json", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    hooks: { events: ["Stop"] },
  });
  await startResult;
  const args = [...launcher.args];
  const idx = args.indexOf("--settings");
  const settingsPath = args[idx + 1];
  if (!settingsPath) throw new Error("missing --settings value");
  const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
    hooks: Record<string, unknown>;
  };
  expect(Object.keys(parsed.hooks)).toEqual(["Stop"]);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("clear writes escape then /clear to the PTY in order", async () => {
  // The fake launcher records every write; clear() must inject Escape (\x1b)
  // first to dismiss any transient UI state, then /clear\r to reset context.
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    cleanSession: true,
  });
  await startResult;
  await supervisor.clear(FAKE_SESSION_ID);
  const writes = launcher.writes.join("");
  expect(writes).toContain("\x1b");
  expect(writes).toContain("/clear\r");
  expect(launcher.writes.indexOf("\x1b")).toBeLessThan(launcher.writes.indexOf("/clear\r"));
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("clear rejects before start with 'not started'", async () => {
  const supervisor = new ClaudeCodeSupervisor({ launcherFactory: captureLauncherFactory() });
  await expect(supervisor.clear(FAKE_SESSION_ID)).rejects.toThrow("not started");
});

test("cleanSession keeps user-tier exclusion without --disable-slash-commands", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    cleanSession: true,
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--setting-sources");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(args).not.toContain("--safe-mode");
  expect(args).not.toContain("--disable-slash-commands");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("default keeps the existing trimming flags and no --safe-mode", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
  });
  await startResult;
  const args = [...launcher.args];
  expect(args).not.toContain("--safe-mode");
  expect(args).toContain("--disable-slash-commands");
  expect(args).toContain("--setting-sources");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("rawModel adds --disallowed-tools with the built-in tools list", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    rawModel: true,
  });
  await startResult;
  const args = [...launcher.args];
  const i = args.indexOf("--disallowed-tools");
  expect(i).toBeGreaterThan(-1);
  expect(args[i + 1]).toContain("Bash");
  expect(args[i + 1]).toContain("Edit");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("cleanSession with plugin channels throws at construction", () => {
  expect(
    () =>
      new ClaudeCodeSupervisor({
        channels: "plugin",
        cleanSession: true,
        launcherFactory: captureLauncherFactory(),
      }),
  ).toThrow("cleanSession requires dev-flag channels");
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
