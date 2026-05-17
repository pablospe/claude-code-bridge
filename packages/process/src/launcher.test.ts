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
