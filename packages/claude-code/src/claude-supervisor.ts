import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchBridgeTool,
  emitCrashEvents,
  HookFanin,
  type HookFaninMetrics,
  type Supervisor,
  type SupervisorContext,
  type SupervisorFactory,
} from "@ccb/core";
import { ControlServer, type ControlServerEndpoint } from "@ccb/mcp-channel";
import { launch as defaultLaunch, type LauncherHandle, type LaunchOpts } from "@ccb/process";
import { generateHooksSettings, generateMcpConfig, type HookEvent } from "./config.ts";

/**
 * How the supervisor asks `claude` to load the ccb channel server.
 *
 * - `dev-flag` uses `--dangerously-load-development-channels server:ccb` and
 *   prints a "Press Enter to continue" gate the supervisor auto-confirms.
 * - `plugin` uses `--channels plugin:ccb@claude-code-bridge` and requires the user to
 *   have run `claude plugin install` first; no gate to confirm.
 */
export type ChannelsMode = "dev-flag" | "plugin";

/**
 * Hook for tests to swap node-pty out for an in-process fake. Defaults to the
 * real `launch` from `@ccb/process`. The factory shape matches `launch` 1:1.
 */
export type LauncherFactory = (
  command: string,
  args: readonly string[],
  opts?: LaunchOpts,
) => LauncherHandle;

/**
 * Hook for tests to swap `node:fs/promises`'s `writeFile` for an in-process
 * fake (e.g. to simulate EACCES). Matches the subset of the real signature the
 * supervisor uses — either the plain encoding form or the
 * `{ encoding, mode }` object form (used for the per-session settings.json,
 * which is created with mode `0600`).
 */
export type WriteFileFn = (
  path: string,
  data: string,
  options: "utf8" | { encoding: "utf8"; mode?: number },
) => Promise<void>;

export interface ClaudeCodeSupervisorOptions {
  /**
   * Channels mode. Default `"dev-flag"` so fresh clones work without a
   * preceding `claude plugin install` step.
   */
  readonly channels?: ChannelsMode;
  /**
   * Delay before the first blind `\r` write if the dev-channels hint never
   * surfaces via `onData`. Default 3000ms — earlier than the hint reliably
   * appears under cold-boot, but late enough to give a fast boot a chance to
   * be detected via the fast path first.
   */
  readonly autoConfirmInitialDelayMs?: number;
  /**
   * Interval between subsequent blind `\r` writes after the initial delay,
   * up to `autoConfirmMaxAttempts` total writes. Default 3000ms — covers a
   * boot that consumes the prompt several seconds after the hint would have
   * been printable, which strace-style scheduling perturbation reliably
   * reproduces.
   */
  readonly autoConfirmRetryIntervalMs?: number;
  /**
   * Hard cap on the number of blind `\r` writes the scanner emits. Default 6
   * — covers a ~20s boot window comfortably while keeping the worst-case
   * stray-empty-turn count bounded if claude already booted past the prompt.
   */
  readonly autoConfirmMaxAttempts?: number;
  /** Override the launcher (test seam). */
  readonly launcherFactory?: LauncherFactory;
  /** Override fs writeFile (test seam). */
  readonly writeFile?: WriteFileFn;
  /**
   * Hook events to register with claude via a per-session settings.json. When
   * set, the supervisor writes the snippet returned by `generateHooksSettings`
   * to a mode-0600 file under its own temp dir and passes the path through
   * `--settings`. Off by default; flip on for observational tool-event
   * visibility (see docs/M3.md).
   */
  readonly hooks?: { readonly events: ReadonlyArray<HookEvent> };
  /**
   * Drop the operator's user-tier customizations from the driven session
   * while keeping the bridge channel functional. Implemented as the
   * dev-flag trim (--strict-mcp-config + --setting-sources project,local —
   * which on claude >= 2.1.169 also excludes user-enabled plugins and
   * hooks) minus --disable-slash-commands, which clear() needs to inject
   * /clear. Verified empirically: --safe-mode severs the --mcp-config
   * channel, and CLAUDE_CONFIG_DIR breaks the channels-to-MCP binding
   * (claude replies in the TUI instead of bridge_reply), so neither is
   * usable here. Requires dev-flag channels: plugin mode resolves the ccb
   * channel through the user tier this option excludes.
   */
  readonly cleanSession?: boolean;
  /**
   * Disallow claude's own built-in tools so the session can only answer via
   * the bridge tools — it behaves like a bare model rather than an agent.
   */
  readonly rawModel?: boolean;
  /**
   * Declare the permission relay capability to the channel server (via the
   * generated mcp.json env flag) and surface `permission.requested` events as
   * the channel reports tool-permission prompts. Off by default.
   */
  readonly enablePermissionRelay?: boolean;
  /**
   * Extra built-in tool names appended to `--allowed-tools` so they run
   * without prompting (in addition to the bridge tools). Empty by default.
   */
  readonly allowedBuiltinTools?: ReadonlyArray<string>;
}

/**
 * Substring the dev-channels gate prints before the confirm. Verified
 * empirically against `claude --dangerously-load-development-channels` in
 * v2.1.143 — the rendered UI shows "Enter to confirm · Esc to cancel".
 *
 * IMPORTANT: claude's TUI emits each space between words as the ANSI CSI
 * sequence `[1C` (cursor-forward-1), not a literal space byte. So a
 * naive substring match for "Enter to confirm" against the raw PTY stream
 * never fires. `stripAnsi()` removes CSI sequences before matching so the
 * fast-path detection works on a runtime where onData fires (Node); the
 * blind-write fallback is the production safety net regardless.
 */
const DEV_CHANNELS_CONFIRM_HINT = "Enter to confirm";
// Whitespace-stripped form for matching. claude lays the dialog out with
// absolute-column cursor codes (`Enter\x1b[9Gto\x1b[12Gconfirm`), which
// normalizePty deletes — so the rendered hint arrives as "Entertoconfirm"
// with no spaces. Comparing both sides whitespace-free is robust to whatever
// positioning scheme claude uses, instead of guessing which CSI codes map to
// spaces.
const DEV_CHANNELS_CONFIRM_HINT_COMPACT = DEV_CHANNELS_CONFIRM_HINT.replace(/\s+/g, "");

/**
 * Strip ANSI CSI escape sequences from a string so the hint-substring match
 * can compare against the rendered text rather than raw PTY bytes. The
 * pattern is intentionally narrow (CSI escape introducer + parameter bytes
 * + final byte in 0x40–0x7E); we do not need a full ANSI parser, just
 * enough to drop the `[1C` etc. that claude emits between every word.
 */
function normalizePty(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching CSI escape sequences requires the ESC control byte.
      .replace(/\x1b\[\d*[CD]/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching CSI escape sequences requires the ESC control byte.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  );
}

/**
 * Time before the first blind `\r` is written when the hint never surfaces
 * via onData. 3s is earlier than the original 5s single-shot because we now
 * retry — a slightly early miss is recovered by the next attempt.
 */
// The dev-channels confirmation dialog appears immediately when claude
// boots with `--dangerously-load-development-channels`. Empirical finding
// (under strace and direct manual launches): the dialog is on screen
// within ~200ms of PTY allocation. At 3000ms our blind \r missed the
// dialog window on fast hosts — claude had already moved past it. 500ms
// gives the PTY time to settle while still landing inside the dialog
// window. The retry interval (3s) covers any host where 500ms is too
// aggressive.
const DEFAULT_AUTO_CONFIRM_INITIAL_DELAY_MS = 500;
/**
 * Spacing between subsequent blind `\r` writes. 3s matches the initial delay
 * so the schedule is simple to reason about: \r at 3, 6, 9, ... seconds.
 */
const DEFAULT_AUTO_CONFIRM_RETRY_INTERVAL_MS = 3_000;
/**
 * Pause between the Escape and the /clear write so the TUI processes the
 * key and re-renders an empty input box before receiving the command. The
 * TUI reacts to a keypress well within one frame (~16ms); 50ms adds margin
 * without meaningfully delaying the pool's acquire path.
 */
const CLEAR_ESCAPE_SETTLE_MS = 50;
/**
 * Pause after writing /clear before clear() resolves, giving the TUI time
 * to process the command before the pool hands the session to the next
 * turn (whose prompt arrives over the MCP channel, a separate transport
 * that does not queue behind PTY keystrokes). A blind delay, not a
 * readback: it narrows the race window rather than closing it. The
 * fast-follow is to scan PTY output for the post-/clear redraw like the
 * auto-confirm scanner does. /clear completes locally (no network), so
 * 300ms is generous; against multi-second turns it is negligible latency.
 */
const CLEAR_COMMAND_SETTLE_MS = 300;
/**
 * Maximum number of blind `\r` writes the scanner will emit. 6 covers a
 * ~20s boot window (3 + 5*3 = 18s of the 30s Bridge.startTimeoutMs default)
 * while keeping stray-empty-turn fallout bounded if claude already booted.
 */
const DEFAULT_AUTO_CONFIRM_MAX_ATTEMPTS = 6;
/**
 * Sliding-window cap for the auto-confirm scan buffer. A noisy boot (locale
 * init, debug spam, slow tty redraw) could otherwise grow the buffer
 * unbounded for the full auto-confirm window. The cap holds 4 KB — comfortably
 * larger than the hint substring (~30 bytes) so a hint split across two PTY
 * chunks remains detectable even after the cap kicks in.
 */
const AUTO_CONFIRM_BUFFER_MAX = Math.max(4096, DEV_CHANNELS_CONFIRM_HINT.length * 2);

const ALLOWED_TOOLS = "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done";

// Best-effort denylist of claude's built-in tool surface; --allowed-tools still
// pre-approves only the bridge tools, so anything missed here prompts rather than runs.
const DISALLOWED_BUILTIN_TOOLS =
  "Bash BashOutput KillShell Edit MultiEdit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit TodoWrite SlashCommand Skill ExitPlanMode";

/**
 * Resolve the absolute path to `packages/mcp-channel/src/bin.ts` so the
 * generated `.mcp.json` does not depend on PATH lookups for `bunx
 * ccb-channel-server`. The supervisor and the bin live in sibling packages so
 * the relative jump is stable.
 */
function resolveChannelServerBinPath(): string {
  const here = fileURLToPath(import.meta.url);
  // .../packages/claude-code/src/claude-supervisor.ts -> packages/
  const packagesDir = resolvePath(dirname(here), "..", "..");
  return resolvePath(packagesDir, "mcp-channel", "src", "bin.ts");
}

/**
 * Resolve the absolute path to `packages/mcp-channel/src/hook-relay.ts` so
 * the per-session settings.json registers the relay bin by its actual file
 * location — no PATH lookup for `bunx ccb-hook-relay` from the managed path.
 */
function resolveHookRelayBinPath(): string {
  const here = fileURLToPath(import.meta.url);
  const packagesDir = resolvePath(dirname(here), "..", "..");
  return resolvePath(packagesDir, "mcp-channel", "src", "hook-relay.ts");
}

/**
 * Supervisor that owns the spawned `claude` process for the lifetime of a
 * session. Boots `claude` via a PTY (claude exits to `--print` when stdout is
 * not a TTY), wires a per-session `.mcp.json` so the channel server connects
 * back to our local ControlServer, and forwards user messages over the
 * control protocol (the PTY is the boot substrate only).
 */
export class ClaudeCodeSupervisor implements Supervisor {
  readonly #channels: ChannelsMode;
  readonly #autoConfirmInitialDelayMs: number;
  readonly #autoConfirmRetryIntervalMs: number;
  readonly #autoConfirmMaxAttempts: number;
  readonly #launcherFactory: LauncherFactory;
  readonly #writeFile: WriteFileFn;
  readonly #hooks: { readonly events: ReadonlyArray<HookEvent> } | undefined;
  readonly #cleanSession: boolean;
  readonly #rawModel: boolean;
  readonly #enablePermissionRelay: boolean;
  readonly #allowedBuiltinTools: ReadonlyArray<string>;

  #ctx: SupervisorContext | undefined;
  #server: ControlServer | undefined;
  #serverEndpoint: ControlServerEndpoint | undefined;
  #launcher: LauncherHandle | undefined;
  #tempDir: string | undefined;
  #settingsPath: string | undefined;
  #autoConfirmCleanup: (() => void) | undefined;
  #hookFanin: HookFanin | undefined;

  constructor(options: ClaudeCodeSupervisorOptions = {}) {
    this.#channels = options.channels ?? "dev-flag";
    this.#autoConfirmInitialDelayMs =
      options.autoConfirmInitialDelayMs ?? DEFAULT_AUTO_CONFIRM_INITIAL_DELAY_MS;
    this.#autoConfirmRetryIntervalMs =
      options.autoConfirmRetryIntervalMs ?? DEFAULT_AUTO_CONFIRM_RETRY_INTERVAL_MS;
    this.#autoConfirmMaxAttempts =
      options.autoConfirmMaxAttempts ?? DEFAULT_AUTO_CONFIRM_MAX_ATTEMPTS;
    this.#launcherFactory =
      options.launcherFactory ?? ((cmd, args, opts) => defaultLaunch(cmd, [...args], opts));
    this.#writeFile = options.writeFile ?? writeFile;
    this.#hooks = options.hooks;
    this.#cleanSession = options.cleanSession ?? false;
    this.#rawModel = options.rawModel ?? false;
    this.#enablePermissionRelay = options.enablePermissionRelay ?? false;
    this.#allowedBuiltinTools = options.allowedBuiltinTools ?? [];
    for (const name of this.#allowedBuiltinTools) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        throw new Error(
          `allowedBuiltinTools entries must match /^[A-Za-z0-9_-]+$/ (got ${JSON.stringify(name)}) — ` +
            "internal whitespace would broaden the space-delimited --allowed-tools value",
        );
      }
    }
    if (this.#cleanSession && this.#channels === "plugin") {
      throw new Error("cleanSession requires dev-flag channels");
    }
  }

  /**
   * Address of the internal ControlServer once it has bound, undefined before
   * `start()` has reached its `server.listen` call and undefined again after
   * `close()`. Exposed as a test seam so a test rig can connect a real
   * `ControlClient` to the supervisor's endpoint (which triggers the
   * synthetic `hello` the start gate awaits). Not part of the `Supervisor`
   * contract — production code routes through the bridge.
   */
  get serverEndpoint(): ControlServerEndpoint | undefined {
    return this.#serverEndpoint;
  }

  /**
   * Pre-hello hook queue metrics. Test/debug seam — not part of the
   * `Supervisor` contract. Returns `undefined` before `start()` and after
   * `close()`.
   */
  get hookMetrics(): HookFaninMetrics | undefined {
    return this.#hookFanin?.metrics();
  }

  async start(ctx: SupervisorContext): Promise<void> {
    if (this.#server || this.#launcher) {
      throw new Error("supervisor already started");
    }
    this.#ctx = ctx;
    const sessionId = ctx.sessionId;

    const server = new ControlServer();
    const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
    this.#server = server;
    server.on("tool", (sid, name, args) => {
      if (sid !== sessionId) return;
      const current = this.#ctx;
      if (!current) return;
      dispatchBridgeTool(current, name, args);
    });
    this.#hookFanin = new HookFanin(ctx);
    server.on("hook", (sid, event, payload) => {
      if (sid !== sessionId) return;
      this.#hookFanin?.onHook(event, payload);
    });
    server.on("hello", (sid) => {
      if (sid !== sessionId) return;
      this.#hookFanin?.onHello();
    });
    server.on("permission-request", (sid, requestId, toolName, description, inputPreview) => {
      if (sid !== sessionId) return;
      const current = this.#ctx;
      if (!current) return;
      current.emit({
        type: "permission.requested",
        sessionId: sid,
        requestId,
        toolName,
        description,
        inputPreview,
      });
    });
    // Channel-server peer dropped its TCP control connection (crash, kill -9).
    // Synthesize the crash event pair so the bridge transitions the session
    // out of "open" and live consumers see the disconnect. ControlServer
    // suppresses peer-close during its own cooperative close path, so this
    // listener fires only on unexpected disconnects.
    server.on("peer-close", (sid) => {
      if (sid !== sessionId) return;
      this.#hookFanin?.onPeerClose();
      const current = this.#ctx;
      if (!current) return;
      emitCrashEvents(current);
    });
    // Arm the start gate BEFORE publishing the endpoint: boot continues with
    // async config writes below, and a client that connects as soon as the
    // endpoint is visible would otherwise land its hello before the gate
    // listener exists and hang start() forever.
    const helloGate = this.#armChannelHelloGate(sessionId, server);
    this.#serverEndpoint = endpoint;

    const tempDir = await mkdtemp(join(tmpdir(), "ccb-claude-mcp-"));
    this.#tempDir = tempDir;
    // Any failure after mkdtemp must clean up the temp dir (and the bound
    // ControlServer) before propagating, so a write-time EACCES / disk-full
    // does not orphan the dir under tmpdir().
    try {
      const mcpConfigPath = join(tempDir, "mcp.json");
      const channelBin = resolveChannelServerBinPath();
      // Runtime for the channel server + hook relay. Defaults to the current
      // runtime (process.execPath). ccb's mcp-channel is not yet fully
      // Node-compatible, so when ccb runs embedded under Node (e.g. inside an
      // OpenClaw gateway) the channel `hello` handshake can silently stall;
      // setting CCB_CHANNEL_RUNTIME (e.g. to a `bun` path) runs the channel
      // server under a compatible runtime without changing the host process.
      const channelRuntimeCommand =
        (process.env.CCB_CHANNEL_RUNTIME ?? "").trim() || process.execPath;
      const config = generateMcpConfig({
        sessionId,
        endpoint: endpoint.endpoint,
        command: channelRuntimeCommand,
        args: [channelBin],
        enablePermissionRelay: this.#enablePermissionRelay,
      });
      await this.#writeFile(mcpConfigPath, JSON.stringify(config, null, 2), "utf8");

      if (this.#hooks) {
        const settingsPath = join(tempDir, "settings.json");
        const settings = generateHooksSettings({
          events: this.#hooks.events,
          command: channelRuntimeCommand,
          args: [resolveHookRelayBinPath()],
        });
        // mode 0600 per docs/M3.md: the file lives under tmpdir() for the
        // lifetime of the session; user-only read/write is the right default
        // because the hook-relay command line carries no secrets but the
        // settings.json is per-session and unrelated to other users.
        await this.#writeFile(settingsPath, JSON.stringify(settings, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        this.#settingsPath = settingsPath;
      }

      const args = this.#buildClaudeArgs(mcpConfigPath, process.cwd());
      // Propagate the dynamic bridge endpoint + session id through claude's
      // environment so plugin-mode mcpServers entries that template
      // `${CCB_BRIDGE_ENDPOINT}` / `${CCB_SESSION_ID}` resolve correctly. In
      // dev-flag mode these are also picked up by the channel-server child via
      // --mcp-config; the duplication is harmless.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") env[k] = v;
      }
      env.CCB_BRIDGE_ENDPOINT = endpoint.endpoint;
      env.CCB_SESSION_ID = sessionId;
      const launcher = this.#launcherFactory("claude", args, { env });
      this.#launcher = launcher;
      helloGate.attachExitFailFast(launcher);
    } catch (err) {
      await this.#cleanupTempFiles();
      this.#settingsPath = undefined;
      this.#ctx = undefined;
      this.#hookFanin = undefined;
      const closingServer = this.#server;
      this.#server = undefined;
      this.#serverEndpoint = undefined;
      if (closingServer) {
        try {
          await closingServer.close();
        } catch {
          /* best effort */
        }
      }
      throw err;
    }

    if (this.#channels === "dev-flag") {
      this.#installAutoConfirmScanner();
    }
    // Block until the channel server (spawned by claude after it consumes the
    // generated mcp.json) connects back and identifies itself for this
    // session. Without this gate, callers race ahead of the connection and
    // sendMessage rejects with "no connected client". The wait itself is
    // unbounded inside the supervisor; Bridge.startTimeoutMs is the single
    // bound on supervisor.start at the layer above.
    await helloGate.promise;
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.deliver(sessionId, content, { messageId });
  }

  async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.respond(sessionId, requestId, behavior);
  }

  async interrupt(_sessionId: string): Promise<void> {
    const launcher = this.#launcher;
    if (!launcher) return;
    launcher.sendSignal("SIGINT");
  }

  /**
   * Write `/clear` into the TUI to reset the session's conversation context.
   *
   * Delivery is fire-and-forget — the PTY write is a no-op if the process
   * already exited, and a successful return does not confirm the TUI processed
   * the command. After writing /clear the method waits CLEAR_COMMAND_SETTLE_MS
   * before resolving; this narrows (does not close) the race against the next
   * turn's MCP-delivered prompt. Callers must ensure the session is idle (no
   * in-flight turn) before calling.
   */
  async clear(sessionId: string): Promise<void> {
    const launcher = this.#launcher;
    if (!this.#ctx || !launcher) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    // Escape first dismisses any transient UI state (autocomplete popup,
    // half-typed text); the pool only clears idle sessions so the input box
    // is otherwise empty.
    launcher.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, CLEAR_ESCAPE_SETTLE_MS));
    launcher.write("/clear\r");
    await new Promise((resolve) => setTimeout(resolve, CLEAR_COMMAND_SETTLE_MS));
  }

  async close(_sessionId: string): Promise<void> {
    this.#autoConfirmCleanup?.();
    this.#autoConfirmCleanup = undefined;

    const launcher = this.#launcher;
    this.#launcher = undefined;
    const server = this.#server;
    this.#server = undefined;
    this.#serverEndpoint = undefined;
    this.#ctx = undefined;
    this.#hookFanin = undefined;
    // The settings.json file lives under #tempDir, so #cleanupTempFiles
    // (called below) removes it transitively. We null #settingsPath here so a
    // subsequent #buildClaudeArgs (e.g. a future restart) does not pass a
    // stale --settings path.
    this.#settingsPath = undefined;

    if (launcher) {
      try {
        // The launcher already implements the full graceful → SIGINT →
        // SIGTERM → SIGKILL ladder within a bounded budget. We just supply
        // the claude-specific keystroke ("/exit" — the slash command; bare
        // "exit" would be sent to the model as a user message).
        await launcher.kill("graceful", { gracefulInput: "/exit\n" });
      } catch (err) {
        console.error(`ClaudeCodeSupervisor: launcher.kill failed: ${String(err)}`);
      }
    }
    if (server) {
      try {
        await server.close();
      } catch (err) {
        console.error(`ClaudeCodeSupervisor: server close failed: ${String(err)}`);
      }
    }
    await this.#cleanupTempFiles();
  }

  #buildClaudeArgs(mcpConfigPath: string, cwd: string): string[] {
    const args: string[] = [];
    if (this.#channels === "dev-flag") {
      // Dev-flag mode: declare the channel server via --mcp-config + the
      // development channels load flag. --strict-mcp-config keeps the
      // surface narrow so unrelated MCP servers from the user's settings
      // don't get picked up.
      args.push("--dangerously-load-development-channels", "server:ccb");
      args.push("--mcp-config", mcpConfigPath);
      args.push("--strict-mcp-config");
      // Trim boot cost: skip the user-tier config (the operator's global
      // plugins, MCP servers, and hooks) and the slash-command surface. A
      // managed launch is a programmatic single-turn driver, not the user's
      // interactive session, so none of that is needed and it dominates boot.
      // Safe only in dev-flag mode: the channel comes from --mcp-config here,
      // so dropping the user tier doesn't cut off the channel. (Plugin mode
      // resolves the ccb plugin THROUGH the user-tier marketplace, so the same
      // exclusion would break it — hence this stays out of the plugin branch.)
      args.push("--setting-sources", "project,local");
      if (!this.#cleanSession) {
        // A programmatic single-turn driver doesn't need the slash-command
        // surface — except clear(), which types /clear into the TUI. Clean
        // sessions therefore keep slash commands available.
        args.push("--disable-slash-commands");
      }
    } else {
      // Plugin mode: the channel server is declared by the plugin's
      // mcpServers entry, which claude loads from the plugin's manifest.
      // Adding --mcp-config + --strict-mcp-config here would cut that
      // path off (strict-mcp-config restricts MCP loading to the file we
      // provide). The plugin's manifest references the dynamic endpoint
      // via `${CCB_BRIDGE_ENDPOINT}` / `${CCB_SESSION_ID}` substitution,
      // which we inject into claude's environment before spawn.
      args.push("--channels", "plugin:ccb@claude-code-bridge");
    }
    args.push("--add-dir", cwd);
    if (this.#settingsPath !== undefined) {
      args.push("--settings", this.#settingsPath);
    }
    const allowedTools = [ALLOWED_TOOLS, ...this.#allowedBuiltinTools].join(" ");
    args.push("--allowed-tools", allowedTools);
    if (this.#rawModel) {
      args.push("--disallowed-tools", DISALLOWED_BUILTIN_TOOLS);
    }
    return args;
  }

  /**
   * Install the start gate: the returned promise resolves once the channel
   * server's first `hello` for this session arrives at the ControlServer.
   * Armed before the endpoint is published (so an early hello cannot be
   * lost); the launcher's exit fail-fast is attached later via
   * `attachExitFailFast` because the launcher does not exist yet at arming
   * time. The promise never resolves on its own otherwise; the caller
   * (`Bridge.startSession` via `startTimeoutMs`) is the single source of
   * truth for bounding this wait so the timeout story stays in one place.
   */
  #armChannelHelloGate(
    sessionId: string,
    server: ControlServer,
  ): { promise: Promise<void>; attachExitFailFast: (launcher: LauncherHandle) => void } {
    let resolveGate!: () => void;
    let rejectGate!: (err: Error) => void;
    let settled = false;
    let disposeExit: (() => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    const onHello = (sid: string): void => {
      if (sid !== sessionId) return;
      server.off("hello", onHello);
      disposeExit?.();
      settled = true;
      resolveGate();
    };
    server.on("hello", onHello);
    return {
      promise,
      // Fail fast if claude exits before the channel server connects (bad
      // flag, crash, unconfirmed dev-channels gate). Without this the wait
      // only ends on `hello`, so a boot that has already failed still blocks
      // for the full Bridge.startTimeoutMs before the timeout path fires.
      // Bridge.startSession runs supervisor.close() on this rejection.
      attachExitFailFast: (launcher: LauncherHandle): void => {
        disposeExit = launcher.onExit(({ code, signal }) => {
          if (settled) return;
          server.off("hello", onHello);
          settled = true;
          rejectGate(
            new Error(
              `claude exited during boot before the channel connected (code=${code}${
                signal ? `, signal=${signal}` : ""
              })`,
            ),
          );
        });
      },
    };
  }

  /**
   * Buffer PTY output and write `\r` once the dev-channels confirm hint
   * appears. Bounded by `autoConfirmMaxAttempts` blind writes.
   *
   * Two write paths so a runtime that does not surface PTY `onData` callbacks
   * does not deadlock the boot — and so a slow boot under reliable `onData`
   * does not lose its single shot:
   *
   * 1. Fast path: as soon as the hint substring appears in the buffer, write
   *    `\r` and stop scanning. This is the common case under Node.
   * 2. Fallback: after `autoConfirmInitialDelayMs`, write `\r` blindly, then
   *    keep writing every `autoConfirmRetryIntervalMs` up to
   *    `autoConfirmMaxAttempts` total writes. The fallback covers runtimes
   *    where `onData` does not fire reliably for PTY children (Bun's NAPI
   *    compat layer at the time of writing) AND the slow-boot case where
   *    onData fires but claude isn't ready to consume the first \r yet. Risk
   *    is bounded: if claude already booted past the prompt, each extra `\r`
   *    submits an empty turn — at most `autoConfirmMaxAttempts` stray turns,
   *    no data loss, no crash.
   */
  #installAutoConfirmScanner(): void {
    const launcher = this.#launcher;
    if (!launcher) return;
    let stopped = false;
    let attempts = 0;
    let buffer = "";
    const writeCr = (): void => {
      try {
        // \r is the on-the-wire Enter keypress for a TTY. claude's TUI reads
        // raw keystrokes (no line discipline), so \n is interpreted literally
        // and does NOT advance the dev-channels warning. \r is the correct
        // representation of the key the warning's "Enter to confirm" hint
        // refers to.
        launcher.write("\r");
      } catch {
        /* swallow: PTY may have raced us to closed. */
      }
    };
    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      unsubscribe();
    };
    const fastPath = (): void => {
      if (stopped) return;
      writeCr();
      cleanup();
    };
    const blindAttempt = (): void => {
      if (stopped) return;
      attempts += 1;
      writeCr();
      if (attempts >= this.#autoConfirmMaxAttempts) {
        cleanup();
        return;
      }
      timer = setTimeout(blindAttempt, this.#autoConfirmRetryIntervalMs);
      (timer as { unref?: () => void }).unref?.();
    };
    const unsubscribe = launcher.onData((chunk) => {
      if (stopped) return;
      buffer += chunk;
      // Sliding window: anything older than AUTO_CONFIRM_BUFFER_MAX bytes
      // cannot still contain the hint substring (the hint is much smaller
      // than the cap), so trimming earlier bytes is safe and prevents the
      // buffer from growing without bound on a noisy boot.
      if (buffer.length > AUTO_CONFIRM_BUFFER_MAX) {
        buffer = buffer.slice(buffer.length - AUTO_CONFIRM_BUFFER_MAX);
      }
      if (normalizePty(buffer).replace(/\s+/g, "").includes(DEV_CHANNELS_CONFIRM_HINT_COMPACT)) {
        fastPath();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      blindAttempt,
      this.#autoConfirmInitialDelayMs,
    );
    (timer as { unref?: () => void }).unref?.();
    this.#autoConfirmCleanup = cleanup;
  }

  async #cleanupTempFiles(): Promise<void> {
    const tempDir = this.#tempDir;
    this.#tempDir = undefined;
    if (!tempDir) return;
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`ClaudeCodeSupervisor: temp cleanup failed: ${String(err)}`);
    }
  }
}

/**
 * Returns a `SupervisorFactory` suitable for `BridgeOptions.supervisorFactory`.
 * Each session gets its own ClaudeCodeSupervisor instance with the same
 * options.
 */
export function claudeCodeSupervisorFactory(
  options: ClaudeCodeSupervisorOptions = {},
): SupervisorFactory {
  return () => new ClaudeCodeSupervisor(options);
}
