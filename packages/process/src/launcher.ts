/**
 * PTY launcher. This is the only file in the workspace that imports the
 * native PTY module — `@homebridge/node-pty-prebuilt-multiarch`, a community
 * fork of node-pty that ships prebuilt binaries for darwin, win32, and linux
 * (including linux-x64 / linux-arm64) so loading does not require a C++
 * toolchain on the host. The module may still fail to load if the prebuilt
 * binary's NAPI ABI is incompatible with the running runtime; callers that
 * hit that path get a typed `LauncherUnavailableError` with a pointer at
 * `docs/SMOKE.md`'s manual fallback.
 */

import { read as fsRead, write as fsWrite } from "node:fs";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";

/** Public error type for the node-pty-unavailable path. */
export class LauncherUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "node-pty failed to load; managed launch is unavailable. " +
        "See docs/SMOKE.md (Advanced fallback) for the manual three-terminal procedure. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "LauncherUnavailableError";
    this.cause = cause;
  }
}

export interface LaunchOpts {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface KillOpts {
  /**
   * Bytes written to the child's PTY during the graceful step. The launcher
   * does not assume a specific application — callers pass the right keystroke
   * for their target child (e.g. `"exit\n"` for bash, `"/exit\n"` for claude).
   */
  gracefulInput?: string;
}

export interface LauncherHandle {
  readonly pid: number;
  write(data: string): void;
  kill(mode: "graceful" | "signal", opts?: KillOpts): Promise<void>;
  /**
   * Deliver a single POSIX signal to the child without escalation. Used by
   * supervisors that need a Ctrl-C analog ("SIGINT") distinct from the
   * SIGTERM-first behavior of `kill("signal")`. No-op after exit.
   */
  sendSignal(signal: NodeJS.Signals): void;
  waitExit(): Promise<{ code: number; signal?: string }>;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (exit: { code: number; signal?: string }) => void): () => void;
}

/**
 * Minimal slice of node-pty's IPty surface the launcher relies on. Captured as
 * a local interface so the only place we depend on node-pty's typings is
 * inside `loadNodePty()`.
 */
interface PtyTerminal {
  readonly pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): { dispose: () => void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void };
}

interface PtyModule {
  spawn(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number },
  ): PtyTerminal;
}

/**
 * Kill-ladder timings, fixed per M2.md §1. Total budget 5s = 1s + 1.5s + 1.5s
 * (bounded waits) + 1s of slack to absorb signal-delivery latency. Not
 * configurable: the supervisor caller has a hard 5s teardown budget that
 * matches these numbers.
 */
const GRACEFUL_WAIT_MS = 1_000;
const SIGINT_WAIT_MS = 1_500;
const SIGTERM_WAIT_MS = 1_500;

/**
 * `term.kill(signal)` may throw if the child has raced us to exit. The kill
 * ladder treats every escalation as best-effort: a swallowed throw means the
 * next `waitForExit` either observes the existing exit (returns true) or
 * times out and the ladder steps forward.
 */
function safeKill(term: PtyTerminal, signal: string): void {
  try {
    term.kill(signal);
  } catch {
    /* swallow: see safeKill doc comment. */
  }
}

// Bun exposes `require` in ESM transparently; Node ESM does not. Build a
// CJS-compatible require bound to this module's URL so the same `launch()`
// implementation works under both runtimes. Top-level so the module load
// itself surfaces a problem (rather than the first `launch()` call).
const _require = createRequire(import.meta.url);

/**
 * Under Bun, `tty.ReadStream(fd)` does not emit `'data'` events for non-
 * blocking PTY master file descriptors. node-pty wires its `'data'` event
 * through exactly that stream (`_socket = new tty.ReadStream(term.fd)` in
 * `unixTerminal.js`), so `term.onData` silently never fires. Tracked at
 * oven-sh/bun#25822; root-cause analysis + working polyfill posted by
 * @w4sspr on 2026-04-30 in that thread.
 *
 * Workaround: replace `tty.ReadStream` on Bun BEFORE node-pty is required,
 * with a `Duplex` that drives an `fs.read` poll loop against the fd for
 * reads and an `fs.write` for the write path (node-pty calls
 * `_socket.write(data)`). The fd already owns the PTY master; the stream
 * simply pushes bytes as they arrive, satisfying node-pty's expectation
 * that `_socket` emits `'data'` events. No effect on Node — `tty.ReadStream`
 * is left untouched there.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
let bunTtyPolyfillInstalled = false;
function ensureBunTtyPolyfill(): void {
  if (!isBun || bunTtyPolyfillInstalled) return;
  bunTtyPolyfillInstalled = true;

  /**
   * Drop-in `Duplex` that polls the PTY master fd via `fs.read` and writes
   * via `fs.write`. Ported from the upstream polyfill at oven-sh/bun#25822
   * (comment 2026-04-30 by @w4sspr), adapted from a `Readable` to a `Duplex`
   * because node-pty calls `_socket.write(data)` for the write path
   * (`unixTerminal.js:_write` -> `this._socket.write(data)`). Choices
   * preserved from the upstream design:
   *   - 64 KiB read buffer (fits typical PTY bursts in a single read).
   *   - 5 ms `setTimeout` back-off on EAGAIN (no spin when idle).
   *   - `setImmediate` between reads when data flowed (low latency).
   *   - Push `null` on EIO/EBADF (master closed = EOF).
   *   - Copy the buffer slice before push: subsequent reads overwrite
   *     `_buf` while a slow consumer may still hold prior chunks.
   */
  class PollingPtyStream extends Duplex {
    private readonly _fd: number;
    private readonly _buf: Buffer;
    constructor(fd: number) {
      super({ highWaterMark: 64 * 1024 });
      this._fd = fd;
      this._buf = Buffer.alloc(64 * 1024);
      this._pump();
    }
    override _read(_size: number): void {
      /* noop: data is pushed by _pump */
    }
    override _write(
      chunk: Buffer | string,
      encoding: BufferEncoding,
      cb: (e?: Error | null) => void,
    ): void {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      fsWrite(this._fd, data, 0, data.length, null, (err) => cb(err ?? null));
    }
    override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
      cb(err);
    }
    private _pump(): void {
      if (this.destroyed) return;
      fsRead(this._fd, this._buf, 0, this._buf.length, null, (err, n) => {
        if (this.destroyed) return;
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EAGAIN") {
            setTimeout(() => this._pump(), 5).unref?.();
            return;
          }
          if (code === "EIO" || code === "EBADF") {
            this.push(null);
            return;
          }
          this.emit("error", err);
          return;
        }
        if (n > 0) {
          this.push(Buffer.from(this._buf.subarray(0, n)));
        } else {
          this.push(null);
          return;
        }
        setImmediate(() => this._pump());
      });
    }
  }

  // node-pty's UnixTerminal calls `new tty.ReadStream(term.fd)` and treats
  // the resulting object as a duplex socket (`setEncoding`, `on('data')`,
  // `on('error')`, `on('close')`, `write`, `destroy`, `resume`). Our
  // `PollingPtyStream` implements that contract via `Duplex` semantics.
  //
  // Use `require("tty")` (CJS) rather than `import * as tty from "node:tty"`:
  // ESM namespace objects refuse re-assignment, but the CJS exports object
  // is the same record node-pty resolves via its own `require("tty")` (see
  // `unixTerminal.js:18`), so patching this binding affects the same
  // namespace node-pty observes.
  const ttyModule = _require("tty") as { ReadStream: unknown };
  ttyModule.ReadStream = PollingPtyStream;
}

function loadNodePty(): PtyModule {
  ensureBunTtyPolyfill();
  try {
    return _require("@homebridge/node-pty-prebuilt-multiarch") as PtyModule;
  } catch (err) {
    throw new LauncherUnavailableError(err);
  }
}

export function launch(command: string, args: string[], opts?: LaunchOpts): LauncherHandle {
  const pty = loadNodePty();
  /**
   * Diagnostic seam: when `CCB_STRACE` is set to a non-empty path, wrap the
   * spawned command under strace so every read/write/connect/execve/close/
   * openat syscall is captured to the given file. Motivating case is the
   * NAPI-compat gap in Bun (oven-sh/bun#18546) where node-pty's PTY traffic
   * can be invisible to higher-level instrumentation; strace sits below that
   * layer and produces a faithful trace even when the runtime's libuv shim
   * does not. Requires `strace` installed at `/usr/bin/strace` (Linux only;
   * verify with `command -v strace`). Diagnostic-only — never enable in
   * production, the per-syscall overhead is severe.
   */
  const stracePath = process.env.CCB_STRACE;
  let spawnCommand = command;
  let spawnArgs = args;
  if (stracePath !== undefined && stracePath.length > 0) {
    spawnCommand = "/usr/bin/strace";
    spawnArgs = [
      "-f",
      "-tt",
      "-e",
      "trace=read,write,connect,execve,close,openat",
      "-s",
      "4096",
      "-o",
      stracePath,
      command,
      ...args,
    ];
  }
  let term: PtyTerminal;
  try {
    term = pty.spawn(spawnCommand, spawnArgs, {
      cwd: opts?.cwd,
      env: opts?.env,
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
    });
  } catch (err) {
    throw new LauncherUnavailableError(err);
  }

  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(e: { code: number; signal?: string }) => void>();
  let exit: { code: number; signal?: string } | undefined;
  const exitWaiters: Array<(e: { code: number; signal?: string }) => void> = [];
  /**
   * In-flight kill ladder. Concurrent `kill()` callers share this promise so
   * the escalation ladder runs exactly once; without it each caller would
   * walk the ladder independently and re-fire signals at each step.
   */
  let killPromise: Promise<void> | undefined;

  term.onData((chunk) => {
    for (const cb of dataListeners) cb(chunk);
  });
  term.onExit((e) => {
    exit = {
      code: e.exitCode,
      signal: e.signal !== undefined && e.signal !== null ? String(e.signal) : undefined,
    };
    for (const cb of exitListeners) cb(exit);
    for (const w of exitWaiters.splice(0)) w(exit);
  });

  /**
   * Resolves true if the child exits within `timeoutMs`, false on timeout.
   * Local helper used by each step of the kill ladder; consumes one slot in
   * `exitWaiters` per call and cleans up that slot on timeout so a late exit
   * does not try to resolve a dropped promise.
   */
  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (exit) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      exitWaiters.push(onExit);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = exitWaiters.indexOf(onExit);
        if (idx >= 0) exitWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  };

  const runKill = async (
    mode: "graceful" | "signal",
    killOpts: KillOpts | undefined,
  ): Promise<void> => {
    if (exit) return;
    if (mode === "signal") {
      // Single-signal teardown: SIGTERM, then SIGKILL if SIGTERM is ignored
      // within the standard 1.5s window. Caller did not opt into the
      // graceful-input step, so no bytes are written to the PTY.
      safeKill(term, "SIGTERM");
      if (await waitForExit(SIGTERM_WAIT_MS)) return;
      safeKill(term, "SIGKILL");
      return;
    }
    // Graceful ladder: gracefulInput → 1s wait → SIGINT (1.5s) → SIGTERM
    // (1.5s) → SIGKILL. Total of 4s of bounded waits within the 5s budget
    // the supervisor allots for teardown; the 1s slack absorbs the kernel
    // delivering the final signal and the child emitting its exit event.
    const gracefulInput = killOpts?.gracefulInput;
    if (gracefulInput !== undefined && gracefulInput.length > 0) {
      try {
        term.write(gracefulInput);
      } catch {
        /* swallow: child may have raced us to closed stdin. */
      }
    }
    if (await waitForExit(GRACEFUL_WAIT_MS)) return;
    safeKill(term, "SIGINT");
    if (await waitForExit(SIGINT_WAIT_MS)) return;
    safeKill(term, "SIGTERM");
    if (await waitForExit(SIGTERM_WAIT_MS)) return;
    safeKill(term, "SIGKILL");
  };

  const handle: LauncherHandle = {
    get pid() {
      return term.pid;
    },
    write(data) {
      if (exit) return;
      term.write(data);
    },
    sendSignal(signal) {
      if (exit) return;
      safeKill(term, signal);
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
    waitExit() {
      if (exit) return Promise.resolve(exit);
      return new Promise((resolve) => {
        exitWaiters.push(resolve);
      });
    },
    kill(mode, killOpts) {
      if (exit) return Promise.resolve();
      // Share the in-flight ladder with concurrent callers so each escalation
      // step fires exactly once. The cached promise is retained for the
      // lifetime of the handle; after exit, the early-return above short-
      // circuits before this point.
      if (killPromise) return killPromise;
      killPromise = runKill(mode, killOpts);
      return killPromise;
    },
  };

  return handle;
}
