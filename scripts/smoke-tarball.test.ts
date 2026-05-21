import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
// Import the ControlServer directly from its workspace source — `@ccb/*` is
// not symlinked at the repo root because the published package re-exports
// only the public surface, and ControlServer is internal.
import { ControlServer } from "../packages/mcp-channel/src/control.ts";

// The publish artifact is what users actually consume. This smoke proves the
// tarball is shaped right (bins shebanged, plugin manifest present) AND
// functions end-to-end (channel server can boot from the bundled bin and
// reach a ControlServer). bun build externals can subtly break the import
// graph at runtime; the TCP hello round-trip is the smallest assertion that
// exercises the whole bundled stack.

const ROOT = resolve(import.meta.dirname, "..");
// node_modules must be visible to the extracted package because the build
// keeps four dependencies external (@homebridge/node-pty-prebuilt-multiarch,
// @modelcontextprotocol/sdk, commander, zod). Symlinking the repo's
// node_modules into the extract dir gives node the resolution it would have
// after `bun install @pablospe/claude-code-bridge` in a real consumer scope.
const ROOT_NODE_MODULES = resolve(ROOT, "node_modules");

const BIN_NAMES = ["ccb.js", "ccb-channel-server.js", "ccb-hook-relay.js"] as const;
const NODE_SHEBANG = "#!/usr/bin/env node";

interface SpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnAndCollect(
  command: string,
  args: readonly string[],
  opts: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
): { result: Promise<SpawnResult>; kill: (signal?: NodeJS.Signals) => void } {
  const child = spawn(command, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const result = new Promise<SpawnResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
      rejectResult(
        new Error(`${command} ${args.join(" ")} did not exit within ${opts.timeoutMs}ms`),
      );
    }, opts.timeoutMs);
    timer.unref?.();
    child.once("error", (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });

  return {
    result,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    },
  };
}

// Mutable so beforeAll can populate these for use by every test case.
let workDir = "";
let extractDir = "";
let packageDir = "";

describe("tarball smoke", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ccb-smoke-tarball-"));
    extractDir = join(workDir, "extract");

    // `bun pm pack` includes dist/ as a published file; the build must run
    // first or the tarball ships stale or empty bins.
    const build = await $`bun run build`.cwd(ROOT).quiet().nothrow();
    if (build.exitCode !== 0) {
      throw new Error(`bun run build failed (exit ${build.exitCode}):\n${build.stderr.toString()}`);
    }

    const pack = await $`bun pm pack --destination ${workDir} --quiet`.cwd(ROOT).quiet().nothrow();
    if (pack.exitCode !== 0) {
      throw new Error(
        `bun pm pack failed (exit ${pack.exitCode}):\n${pack.stderr.toString()}\n` +
          "If the tarball was not produced, run `bun run build` and check the files glob in package.json.",
      );
    }
    const tarballPath = pack.stdout.toString().trim();
    if (!tarballPath?.endsWith(".tgz")) {
      throw new Error(
        `bun pm pack produced no tarball path (stdout=${JSON.stringify(
          pack.stdout.toString(),
        )}). Run \`bun run build\` first.`,
      );
    }
    const tarballStat = await stat(tarballPath).catch(() => null);
    if (!tarballStat?.isFile()) {
      throw new Error(
        `bun pm pack reported ${tarballPath} but the file is missing — likely a stale build. Run \`bun run build\` and retry.`,
      );
    }

    await $`tar xzf ${tarballPath} -C ${extractDir}`
      .env({ ...process.env })
      .cwd(workDir)
      .quiet()
      .nothrow()
      .then(async (extract) => {
        if (extract.exitCode !== 0) {
          // mkdir before extract — tar fails if the dir doesn't exist.
          throw new Error(
            `tar xzf failed (exit ${extract.exitCode}):\n${extract.stderr.toString()}`,
          );
        }
      })
      .catch(async () => {
        // tar refused because extractDir doesn't exist yet — create and retry.
        await $`mkdir -p ${extractDir}`.quiet().nothrow();
        const retry = await $`tar xzf ${tarballPath} -C ${extractDir}`.quiet().nothrow();
        if (retry.exitCode !== 0) {
          throw new Error(`tar xzf failed (exit ${retry.exitCode}):\n${retry.stderr.toString()}`);
        }
      });

    packageDir = join(extractDir, "package");
    const pkgStat = await stat(packageDir).catch(() => null);
    if (!pkgStat?.isDirectory()) {
      throw new Error(`extracted tarball did not produce a package/ directory at ${packageDir}`);
    }

    // Externals (commander, zod, @modelcontextprotocol/sdk,
    // @homebridge/node-pty-prebuilt-multiarch) are runtime deps in the
    // published package.json. A real install resolves them via npm/bun;
    // here we symlink the bridge repo's node_modules so node's ESM resolver
    // walks into the same versions the dev tree uses.
    await symlink(ROOT_NODE_MODULES, join(packageDir, "node_modules"), "dir");
  }, 120_000);

  afterAll(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  test("bun pm pack produces a tarball that extracts a package/ tree", async () => {
    const entries = await readdir(packageDir);
    expect(entries).toContain("package.json");
    expect(entries).toContain("dist");
  });

  test("each bin file has the Node shebang", async () => {
    for (const name of BIN_NAMES) {
      const file = join(packageDir, "dist", "bin", name);
      const content = await readFile(file, "utf8");
      const firstLine = content.split("\n", 1)[0];
      expect(firstLine).toBe(NODE_SHEBANG);
    }
  });

  test("ccb --help exits 0 and prints usage", async () => {
    const ccb = join(packageDir, "dist", "bin", "ccb.js");
    const { result } = spawnAndCollect("node", [ccb, "--help"], {
      timeoutMs: 5_000,
    });
    const r = await result;
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage:\s+ccb/);
  });

  test("ccb-hook-relay with no args exits 0 with a ccb-hook-relay: stderr line", async () => {
    // M3.3 contract: the relay never blocks claude's turn. Any startup-time
    // failure (missing env, missing event arg, etc.) exits 0 with a
    // `ccb-hook-relay: <reason>` stderr line. Asserting the prefix and exit 0
    // is enough — the specific reason depends on which guard fires first
    // (CCB_SESSION_ID is checked before the event arg in the current impl).
    const bin = join(packageDir, "dist", "bin", "ccb-hook-relay.js");
    const child = spawn("node", [bin], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // hook-relay reads stdin; close it so the read resolves promptly.
    child.stdin.end();
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

    const exitInfo = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        rejectExit(new Error("ccb-hook-relay did not exit within 5s"));
      }, 5_000);
      timer.unref?.();
      child.once("error", (err) => {
        clearTimeout(timer);
        rejectExit(err);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });

    expect(exitInfo.code).toBe(0);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(stderr).toMatch(/^ccb-hook-relay: /);
  });

  test("plugins/ccb/.claude-plugin/plugin.json is present and parses as JSON", async () => {
    const manifestPath = join(packageDir, "plugins", "ccb", ".claude-plugin", "plugin.json");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Sanity-check the minimum shape so a malformed manifest is caught here
    // rather than only at /plugin install time.
    expect(parsed.name).toBe("ccb");
    expect(typeof parsed.mcpServers).toBe("object");
  });

  test(
    "ccb-channel-server boots and sends hello to a ControlServer within 2s",
    async () => {
      // Functional gate: --help only proves arg parsing, not import-graph
      // wiring. The bundled bin must connect over TCP and emit hello with the
      // right sessionId for the publish artifact to be considered working.
      const server = new ControlServer();
      const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
      const sessionId = `smoke-${crypto.randomUUID()}`;

      const helloPromise = new Promise<string>((resolveHello) => {
        server.on("hello", (sid: string) => {
          resolveHello(sid);
        });
      });

      const bin = join(packageDir, "dist", "bin", "ccb-channel-server.js");
      const child = spawn("node", [bin], {
        env: {
          ...process.env,
          CCB_BRIDGE_ENDPOINT: `${endpoint.host}:${endpoint.port}`,
          CCB_SESSION_ID: sessionId,
          // The bin gates hello on the MCP `initialize` handshake completing;
          // disable the post-init settle so this wiring check stays inside 2s.
          CCB_CHANNEL_READY_SETTLE_MS: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stderrChunks: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

      // Drive the MCP initialize handshake the way claude does; the bin
      // withholds its bridge hello until this completes.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smoke", version: "1" },
          },
        })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );

      try {
        const sid = await Promise.race([
          helloPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `hello not received within 2s. stderr=${Buffer.concat(stderrChunks).toString(
                      "utf8",
                    )}`,
                  ),
                ),
              2_000,
            ),
          ),
        ]);
        expect(sid).toBe(sessionId);
      } finally {
        // After hello the channel server stays live in MCP stdio mode and
        // would otherwise hang waiting for input. SIGTERM runs its bounded
        // shutdown path.
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        await new Promise<void>((resolveExit) => {
          const t = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
            resolveExit();
          }, 2_000);
          t.unref?.();
          child.once("close", () => {
            clearTimeout(t);
            resolveExit();
          });
        });
        await server.close();
      }
    },
    { timeout: 10_000 },
  );
});
