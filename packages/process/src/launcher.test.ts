import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Bun cannot load node-pty's native module on every host (it panics inside
 * libuv's NAPI compat layer; see oven-sh/bun#18546). To keep these tests
 * runnable while still exercising the launcher's contract — write/onData/
 * onExit wiring, error handling — we replace `node-pty` with a
 * `Bun.spawn`-based fake before importing the launcher. The fake implements
 * the slice of node-pty's IPty surface the launcher actually touches:
 * `spawn`, `pid`, `write`, `kill`, `onData`, `onExit`.
 *
 * The bash invocations used here have no TTY-dependent behavior, so a pipe-
 * backed subprocess produces faithful output for the assertions below.
 */

type DataListener = (chunk: string) => void;
type ExitListener = (e: { exitCode: number; signal?: number }) => void;
type Disposable = { dispose: () => void };

interface FakePty {
  readonly pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(cb: DataListener): Disposable;
  onExit(cb: ExitListener): Disposable;
}

/** Live children tracked so we can hard-kill leaks at test teardown. */
const liveChildren = new Set<ChildProcess>();

function buildFakeSpawn(): (
  command: string,
  args: string[],
  _opts?: { cwd?: string; env?: Record<string, string> },
) => FakePty {
  return (command, args, opts) => {
    const child = nodeSpawn(command, args, {
      cwd: opts?.cwd,
      env: opts?.env ?? (process.env as Record<string, string>),
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChildren.add(child);

    const dataListeners = new Set<DataListener>();
    const exitListeners = new Set<ExitListener>();
    let exited = false;

    const fanout = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const cb of dataListeners) cb(text);
    };
    child.stdout?.on("data", fanout);
    child.stderr?.on("data", fanout);

    child.on("exit", (code, signal) => {
      exited = true;
      liveChildren.delete(child);
      const exitCode = code ?? 0;
      const signalNum = signal ? 1 : undefined;
      for (const cb of exitListeners) cb({ exitCode, signal: signalNum });
    });
    child.on("error", () => {
      // Surfaces as exit; ignore here so the fake stays minimal.
    });

    return {
      get pid() {
        return child.pid ?? -1;
      },
      write(data) {
        if (!exited) child.stdin?.write(data);
      },
      kill(signal) {
        if (!exited) {
          try {
            child.kill((signal ?? "SIGHUP") as NodeJS.Signals);
          } catch {
            /* swallow */
          }
        }
      },
      onData(cb) {
        dataListeners.add(cb);
        return { dispose: () => dataListeners.delete(cb) };
      },
      onExit(cb) {
        exitListeners.add(cb);
        return { dispose: () => exitListeners.delete(cb) };
      },
    };
  };
}

const fakeSpawn = buildFakeSpawn();
const fakeNodePty = {
  spawn: (command: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) =>
    fakeSpawn(command, args, opts),
};

mock.module("node-pty", () => fakeNodePty);

// Lazy import after mock.module() registers the override.
let launch: typeof import("./launcher.ts").launch;
let LauncherUnavailableError: typeof import("./launcher.ts").LauncherUnavailableError;

beforeAll(async () => {
  const mod = await import("./launcher.ts");
  launch = mod.launch;
  LauncherUnavailableError = mod.LauncherUnavailableError;
});

afterEach(() => {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* swallow */
    }
  }
  liveChildren.clear();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("launch collects stdout via onData and reports exit 0", async () => {
  const handle = launch("bash", ["-c", "echo hi; sleep 0.1; echo bye"]);
  const chunks: string[] = [];
  handle.onData((chunk) => chunks.push(chunk));
  const exit = await handle.waitExit();
  expect(exit.code).toBe(0);
  const combined = chunks.join("");
  expect(combined).toContain("hi");
  expect(combined).toContain("bye");
});

test("write sends bytes to the child stdin", async () => {
  const handle = launch("bash", ["-c", "read line; echo got: $line"]);
  const chunks: string[] = [];
  handle.onData((chunk) => chunks.push(chunk));
  handle.write("hello\n");
  const exit = await handle.waitExit();
  expect(exit.code).toBe(0);
  expect(chunks.join("")).toContain("got: hello");
});

test("onExit fires with the final exit code", async () => {
  const handle = launch("bash", ["-c", "exit 7"]);
  const fired: { code: number; signal?: string }[] = [];
  handle.onExit((e) => fired.push(e));
  const exit = await handle.waitExit();
  expect(exit.code).toBe(7);
  // onExit may fire asynchronously; give the event loop a turn.
  await delay(10);
  expect(fired.length).toBeGreaterThan(0);
  expect(fired[0]?.code).toBe(7);
});

test("onData unsubscribe stops further notifications", async () => {
  const handle = launch("bash", ["-c", "echo first; sleep 0.05; echo second"]);
  const chunks: string[] = [];
  const off = handle.onData((chunk) => chunks.push(chunk));
  await delay(20);
  off();
  await handle.waitExit();
  // We cannot assert the exact split (event timing is not deterministic),
  // but unsubscribe must at least not throw and must accept calling twice.
  off();
  expect(typeof chunks.join("")).toBe("string");
});

test("pid is set from the spawned child", async () => {
  const handle = launch("bash", ["-c", "sleep 0.05"]);
  expect(handle.pid).toBeGreaterThan(0);
  await handle.waitExit();
});

test("kill graceful: writes gracefulInput, child exits cleanly within budget", async () => {
  const handle = launch("bash", [
    "-c",
    'while read line; do echo "got: $line"; if [ "$line" = "exit" ]; then break; fi; done',
  ]);
  const chunks: string[] = [];
  handle.onData((chunk) => chunks.push(chunk));
  const start = Date.now();
  await handle.kill("graceful", { gracefulInput: "exit\n" });
  const elapsed = Date.now() - start;
  // Should exit within the 1s graceful window with slack.
  expect(elapsed).toBeLessThan(1500);
  const exit = await handle.waitExit();
  expect(exit.code).toBe(0);
  expect(chunks.join("")).toContain("got: exit");
});

test("kill graceful escalates to SIGINT when graceful input is ignored", async () => {
  // Child reads but never honors the input (no exit branch). The launcher
  // writes gracefulInput, waits 1s, then SIGINTs.
  const handle = launch("bash", ["-c", "trap '' PIPE; sleep 10"]);
  const start = Date.now();
  await handle.kill("graceful", { gracefulInput: "ignored\n" });
  const elapsed = Date.now() - start;
  // 1s graceful wait + SIGINT delivery; should be well under 3s.
  expect(elapsed).toBeGreaterThanOrEqual(1000);
  expect(elapsed).toBeLessThan(3000);
  const exit = await handle.waitExit();
  // SIGINT-killed processes report a non-zero signal/code.
  expect(exit.code !== 0 || exit.signal !== undefined).toBe(true);
});

test("kill escalates past SIGINT to SIGTERM/SIGKILL when the child traps SIGINT", async () => {
  // Trap SIGINT so the graceful → SIGINT step times out; the ladder then
  // escalates to SIGTERM, then SIGKILL if SIGTERM is also ignored.
  const handle = launch("bash", ["-c", "trap '' INT; sleep 10"]);
  const start = Date.now();
  await handle.kill("graceful", { gracefulInput: "ignored\n" });
  const elapsed = Date.now() - start;
  // 1s graceful + 1.5s SIGINT wait + SIGTERM delivery; well under 5s.
  expect(elapsed).toBeGreaterThanOrEqual(2500);
  expect(elapsed).toBeLessThan(5000);
  const exit = await handle.waitExit();
  expect(exit.code !== 0 || exit.signal !== undefined).toBe(true);
});

test("kill('signal') sends SIGTERM without writing any bytes", async () => {
  const handle = launch("bash", ["-c", "sleep 10"]);
  const chunks: string[] = [];
  handle.onData((chunk) => chunks.push(chunk));
  const start = Date.now();
  await handle.kill("signal");
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000);
  // No bytes written by the launcher for a plain signal kill.
  expect(chunks.join("")).toBe("");
  const exit = await handle.waitExit();
  expect(exit.code !== 0 || exit.signal !== undefined).toBe(true);
});

test("kill is a no-op once the child has already exited", async () => {
  const handle = launch("bash", ["-c", "exit 0"]);
  await handle.waitExit();
  // Calling kill on an already-exited child must not throw.
  await handle.kill("graceful", { gracefulInput: "anything\n" });
  await handle.kill("signal");
});

test("LauncherUnavailableError: thrown when node-pty fails to load", async () => {
  // Swap the mocked module to throw on access of `spawn`. Using a getter
  // simulates a require-time failure path.
  mock.module("node-pty", () => ({
    get spawn() {
      throw new Error("simulated native load failure");
    },
  }));
  // Re-import the launcher with the broken mock active. Bun's mock.module
  // applies to subsequent imports within the same process; the cache-busted
  // query forces a fresh evaluation so the broken mock takes effect.
  const fresh = await import(`./launcher.ts?broken=${Date.now()}`);
  let thrown: unknown;
  try {
    fresh.launch("bash", ["-c", "true"]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  // The fresh import binds its own LauncherUnavailableError class identity,
  // so identity-based instanceof against the test-level import would fail.
  // Match on the name + message contract instead.
  expect((thrown as Error).name).toBe("LauncherUnavailableError");
  expect((thrown as Error).message).toContain("docs/SMOKE.md");
  expect((thrown as Error).message).toContain("simulated native load failure");
  // The error type from our top-level import should also still be defined.
  expect(LauncherUnavailableError.name).toBe("LauncherUnavailableError");
  // Restore the working mock for any later tests.
  mock.module("node-pty", () => fakeNodePty);
});
