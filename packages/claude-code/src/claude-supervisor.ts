import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dispatchBridgeTool,
  emitCrashEvents,
  type Supervisor,
  type SupervisorContext,
  type SupervisorFactory,
} from "@ccb/core";
import { ControlServer, type ControlServerEndpoint } from "@ccb/mcp-channel";
import { launch as defaultLaunch, type LauncherHandle, type LaunchOpts } from "@ccb/process";
import { generateMcpConfig } from "./config.ts";

/**
 * How the supervisor asks `claude` to load the ccb channel server.
 *
 * - `dev-flag` uses `--dangerously-load-development-channels server:ccb` and
 *   prints a "Press Enter to continue" gate the supervisor auto-confirms.
 * - `plugin` uses `--channels plugin:ccb@ccb-local` and requires the user to
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
 * supervisor uses.
 */
export type WriteFileFn = (path: string, data: string, encoding: "utf8") => Promise<void>;

export interface ClaudeCodeSupervisorOptions {
  /**
   * Channels mode. Default `"dev-flag"` so fresh clones work without a
   * preceding `claude plugin install` step.
   */
  readonly channels?: ChannelsMode;
  /**
   * Upper bound on the auto-confirm scan. If the dev-channels hint substring
   * does not appear in the launcher's output within this window, the
   * supervisor stays its hand — it does NOT blind-fire `\n`. Default 5000ms.
   */
  readonly autoConfirmTimeoutMs?: number;
  /**
   * Reserved for symmetry with `Bridge.startTimeoutMs`. Currently unused at
   * this layer because the supervisor itself does not block on a
   * boot-completion signal; the bridge's timeout is the relevant one.
   */
  readonly startTimeoutMs?: number;
  /** Override the launcher (test seam). */
  readonly launcherFactory?: LauncherFactory;
  /** Override fs writeFile (test seam). */
  readonly writeFile?: WriteFileFn;
}

/** Substring the dev-channels gate prints before the confirm. */
const DEV_CHANNELS_CONFIRM_HINT = "Press Enter to continue";
const DEFAULT_AUTO_CONFIRM_TIMEOUT_MS = 5_000;
/**
 * Sliding-window cap for the auto-confirm scan buffer. A noisy boot (locale
 * init, debug spam, slow tty redraw) could otherwise grow the buffer
 * unbounded for the full auto-confirm window. The cap holds 4 KB — comfortably
 * larger than the hint substring (~30 bytes) so a hint split across two PTY
 * chunks remains detectable even after the cap kicks in.
 */
const AUTO_CONFIRM_BUFFER_MAX = Math.max(4096, DEV_CHANNELS_CONFIRM_HINT.length * 2);

const ALLOWED_TOOLS = "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done";

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
 * Supervisor that owns the spawned `claude` process for the lifetime of a
 * session. Boots `claude` via a PTY (claude exits to `--print` when stdout is
 * not a TTY), wires a per-session `.mcp.json` so the channel server connects
 * back to our local ControlServer, and forwards user messages over the
 * control protocol (the PTY is the boot substrate only).
 */
export class ClaudeCodeSupervisor implements Supervisor {
  readonly #channels: ChannelsMode;
  readonly #autoConfirmTimeoutMs: number;
  readonly #launcherFactory: LauncherFactory;
  readonly #writeFile: WriteFileFn;

  #ctx: SupervisorContext | undefined;
  #server: ControlServer | undefined;
  #serverEndpoint: ControlServerEndpoint | undefined;
  #launcher: LauncherHandle | undefined;
  #tempDir: string | undefined;
  #autoConfirmCleanup: (() => void) | undefined;

  constructor(options: ClaudeCodeSupervisorOptions = {}) {
    this.#channels = options.channels ?? "dev-flag";
    this.#autoConfirmTimeoutMs = options.autoConfirmTimeoutMs ?? DEFAULT_AUTO_CONFIRM_TIMEOUT_MS;
    this.#launcherFactory =
      options.launcherFactory ?? ((cmd, args, opts) => defaultLaunch(cmd, [...args], opts));
    this.#writeFile = options.writeFile ?? writeFile;
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

  async start(ctx: SupervisorContext): Promise<void> {
    if (this.#server || this.#launcher) {
      throw new Error("supervisor already started");
    }
    this.#ctx = ctx;
    const sessionId = ctx.sessionId;

    const server = new ControlServer();
    const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
    this.#server = server;
    this.#serverEndpoint = endpoint;
    server.on("tool", (sid, name, args) => {
      if (sid !== sessionId) return;
      const current = this.#ctx;
      if (!current) return;
      dispatchBridgeTool(current, name, args);
    });
    // Channel-server peer dropped its TCP control connection (crash, kill -9).
    // Synthesize the crash event pair so the bridge transitions the session
    // out of "open" and live consumers see the disconnect. ControlServer
    // suppresses peer-close during its own cooperative close path, so this
    // listener fires only on unexpected disconnects.
    server.on("peer-close", (sid) => {
      if (sid !== sessionId) return;
      const current = this.#ctx;
      if (!current) return;
      emitCrashEvents(current);
    });

    const tempDir = await mkdtemp(join(tmpdir(), "ccb-claude-mcp-"));
    this.#tempDir = tempDir;
    // Any failure after mkdtemp must clean up the temp dir (and the bound
    // ControlServer) before propagating, so a write-time EACCES / disk-full
    // does not orphan the dir under tmpdir().
    try {
      const mcpConfigPath = join(tempDir, "mcp.json");
      const channelBin = resolveChannelServerBinPath();
      const config = generateMcpConfig({
        sessionId,
        endpoint: endpoint.endpoint,
        command: process.execPath,
        args: [channelBin],
      });
      await this.#writeFile(mcpConfigPath, JSON.stringify(config, null, 2), "utf8");

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
    } catch (err) {
      await this.#cleanupTempFiles();
      this.#ctx = undefined;
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
    await this.#waitForChannelHello(sessionId, server);
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.deliver(sessionId, content, { messageId });
  }

  async interrupt(_sessionId: string): Promise<void> {
    const launcher = this.#launcher;
    if (!launcher) return;
    launcher.sendSignal("SIGINT");
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
    } else {
      // Plugin mode: the channel server is declared by the plugin's
      // mcpServers entry, which claude loads from the plugin's manifest.
      // Adding --mcp-config + --strict-mcp-config here would cut that
      // path off (strict-mcp-config restricts MCP loading to the file we
      // provide). The plugin's manifest references the dynamic endpoint
      // via `${CCB_BRIDGE_ENDPOINT}` / `${CCB_SESSION_ID}` substitution,
      // which we inject into claude's environment before spawn.
      args.push("--channels", "plugin:ccb@ccb-local");
    }
    args.push("--add-dir", cwd);
    args.push("--allowed-tools", ALLOWED_TOOLS);
    return args;
  }

  /**
   * Resolve once the channel server's first `hello` for this session arrives
   * at the ControlServer. Returns a promise that never rejects on its own; the
   * caller (`Bridge.startSession` via `startTimeoutMs`) is the single source of
   * truth for bounding this wait so the timeout story stays in one place.
   */
  #waitForChannelHello(sessionId: string, server: ControlServer): Promise<void> {
    return new Promise((resolve) => {
      const onHello = (sid: string): void => {
        if (sid !== sessionId) return;
        server.off("hello", onHello);
        resolve();
      };
      server.on("hello", onHello);
    });
  }

  /**
   * Buffer PTY output and write `\n` once the dev-channels confirm hint
   * appears. Bounded by `autoConfirmTimeoutMs`: if the hint never appears in
   * that window the supervisor does NOT send `\n` (the safer failure mode if
   * claude's warning text drifts).
   */
  #installAutoConfirmScanner(): void {
    const launcher = this.#launcher;
    if (!launcher) return;
    let confirmed = false;
    let buffer = "";
    const unsubscribe = launcher.onData((chunk) => {
      if (confirmed) return;
      buffer += chunk;
      // Sliding window: anything older than AUTO_CONFIRM_BUFFER_MAX bytes
      // cannot still contain the hint substring (the hint is much smaller
      // than the cap), so trimming earlier bytes is safe and prevents the
      // buffer from growing without bound on a noisy boot.
      if (buffer.length > AUTO_CONFIRM_BUFFER_MAX) {
        buffer = buffer.slice(buffer.length - AUTO_CONFIRM_BUFFER_MAX);
      }
      if (buffer.includes(DEV_CHANNELS_CONFIRM_HINT)) {
        confirmed = true;
        try {
          launcher.write("\n");
        } catch {
          /* swallow: PTY may have raced us to closed. */
        }
        cleanup();
      }
    });
    const timer = setTimeout(() => {
      if (confirmed) return;
      // Window elapsed; assume the warning text drifted or claude already
      // booted past the prompt. Stay our hand.
      cleanup();
    }, this.#autoConfirmTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      unsubscribe();
    };
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
