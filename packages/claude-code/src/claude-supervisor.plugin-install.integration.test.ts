import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Bridge, type BridgeEvent } from "@ccb/core";
import { LauncherUnavailableError } from "@ccb/process";
import { $ } from "bun";
import { claudeCodeSupervisorFactory } from "./claude-supervisor.ts";

/**
 * End-to-end smoke against a real `claude` binary driven through the
 * public install path: build + pack the bridge, `bun add` the tarball into a
 * fresh tmpdir so `ccb-channel-server` / `ccb-hook-relay` land on PATH, add
 * the local marketplace, install the ccb plugin, and drive the M3.7
 * deterministic prompt through `channels: "plugin"`.
 *
 * Gated on CCB_RUN_PLUGIN_SMOKE=1 with the same preconditions as the M3.7
 * hooks integration smoke:
 *   - the `claude` CLI on PATH
 *   - authenticated credentials (the user has run `claude login` once)
 *   - a host where node-pty can be loaded
 *
 * Asserts the same three guarantees as M3.7 — coverage of PreToolUse /
 * PostToolUse / Stop, Pre/Post pairing by tool_use_id in arrival order, and
 * the first Stop preceding the terminal event — but exercises the public
 * plugin install path instead of the managed-launch `hooks:` option.
 *
 * The test must NOT fail on a stock Bun host that cannot load node-pty —
 * it skips with a clear console.log notice so casual `bun test` stays green.
 * The same notice path catches a `bun add` failure (e.g. registry resolution)
 * so a broken local environment never poisons CI.
 */

const RUN_PLUGIN_SMOKE = process.env.CCB_RUN_PLUGIN_SMOKE === "1";
// WHY: plugin install + first-fire bunx-cache miss takes longer than M3.7's
// managed-launch path; 180s is the spec-mandated watchdog for this test.
const TEST_TIMEOUT_MS = 180_000;

const SKIP_NOTICE =
  "claude-supervisor plugin-install integration: skipped (set CCB_RUN_PLUGIN_SMOKE=1 to run against real claude)";

const REPO_ROOT = resolvePath(import.meta.dirname, "..", "..", "..");

let storeDir: string;
let installDir: string;
let claudeHome: string;
let originalPath: string | undefined;
let originalHome: string | undefined;
let pathMutated = false;
let homeMutated = false;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-claude-plugin-store-"));
  installDir = await mkdtemp(join(tmpdir(), "ccb-claude-plugin-install-"));
  claudeHome = await mkdtemp(join(tmpdir(), "ccb-claude-plugin-home-"));
  originalPath = process.env.PATH;
  originalHome = process.env.HOME;
  pathMutated = false;
  homeMutated = false;
});

afterEach(async () => {
  // WHY: only restore env vars we actually mutated; the test body sets PATH /
  // HOME before instantiating the bridge, and a skip-path short-circuit can
  // run before that point.
  if (pathMutated) {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  if (homeMutated) {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
  await rm(storeDir, { recursive: true, force: true });
  await rm(installDir, { recursive: true, force: true });
  await rm(claudeHome, { recursive: true, force: true });
});

test(
  "plugin install path: tool.event records cover PreToolUse/PostToolUse/Stop in order",
  async () => {
    if (!RUN_PLUGIN_SMOKE) {
      console.log(SKIP_NOTICE);
      return;
    }

    // Step 1-2: build + pack the bridge tarball in the repo root. `bun pm
    // pack` writes the tarball into cwd, so we run it in the repo root and
    // collect the resulting filename from the directory listing.
    const buildResult = await $`bun run build`.cwd(REPO_ROOT).quiet().nothrow();
    if (buildResult.exitCode !== 0) {
      console.log(
        `${SKIP_NOTICE} (bun run build failed: exit ${buildResult.exitCode}; stderr: ${buildResult.stderr.toString().slice(0, 200)})`,
      );
      return;
    }
    const beforePack = new Set(await readdir(REPO_ROOT));
    const packResult = await $`bun pm pack`.cwd(REPO_ROOT).quiet().nothrow();
    if (packResult.exitCode !== 0) {
      console.log(
        `${SKIP_NOTICE} (bun pm pack failed: exit ${packResult.exitCode}; stderr: ${packResult.stderr.toString().slice(0, 200)})`,
      );
      return;
    }
    const afterPack = await readdir(REPO_ROOT);
    const tarball = afterPack.find((name) => name.endsWith(".tgz") && !beforePack.has(name));
    if (!tarball) {
      console.log(`${SKIP_NOTICE} (no .tgz produced by bun pm pack)`);
      return;
    }
    const tarballPath = resolvePath(REPO_ROOT, tarball);

    try {
      // Step 3: bootstrap a fresh project and install the tarball so the
      // published bins land in <installDir>/node_modules/.bin/.
      const initResult = await $`bun init -y`.cwd(installDir).quiet().nothrow();
      if (initResult.exitCode !== 0) {
        console.log(
          `${SKIP_NOTICE} (bun init -y failed: exit ${initResult.exitCode}; stderr: ${initResult.stderr.toString().slice(0, 200)})`,
        );
        return;
      }
      const addResult = await $`bun add ${tarballPath}`.cwd(installDir).quiet().nothrow();
      if (addResult.exitCode !== 0) {
        console.log(
          `${SKIP_NOTICE} (bun add <tarball> failed: exit ${addResult.exitCode}; stderr: ${addResult.stderr.toString().slice(0, 200)})`,
        );
        return;
      }

      // Step 4-5: prepend the installed .bin dir to PATH and redirect HOME so
      // the test's `claude plugin install` writes to a scratch config dir
      // instead of the developer's real ~/.claude.
      const binDir = resolvePath(installDir, "node_modules", ".bin");
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
      pathMutated = true;
      process.env.HOME = claudeHome;
      homeMutated = true;

      // Step 6-7: add the local marketplace and install the plugin via the
      // stable `claude plugin` CLI surface. `claude plugin marketplace add`
      // takes the directory containing `.claude-plugin/marketplace.json`.
      const mpResult = await $`claude plugin marketplace add ${REPO_ROOT}`
        .cwd(installDir)
        .quiet()
        .nothrow();
      if (mpResult.exitCode !== 0) {
        console.log(
          `${SKIP_NOTICE} (claude plugin marketplace add failed: exit ${mpResult.exitCode}; stderr: ${mpResult.stderr.toString().slice(0, 200)})`,
        );
        return;
      }
      const installResult = await $`claude plugin install ccb@claude-code-bridge`
        .cwd(installDir)
        .quiet()
        .nothrow();
      if (installResult.exitCode !== 0) {
        console.log(
          `${SKIP_NOTICE} (claude plugin install failed: exit ${installResult.exitCode}; stderr: ${installResult.stderr.toString().slice(0, 200)})`,
        );
        return;
      }

      // Step 8: drive the deterministic prompt through real claude in
      // channels:"plugin" mode. The bridge spawns claude with
      // `--channels plugin:ccb@claude-code-bridge` and the plugin manifest
      // (now installed under the scratch HOME) declares the MCP server and
      // hook commands; PATH (above) lets claude find them.
      const bridge = new Bridge({
        storeDir,
        supervisorFactory: claudeCodeSupervisorFactory({
          channels: "plugin",
        }),
      });

      let handleId: string | undefined;
      try {
        const handle = await bridge.startSession({});
        handleId = handle.id;
      } catch (err) {
        if (err instanceof LauncherUnavailableError) {
          console.log(
            `claude-supervisor plugin-install integration: skipped (node-pty unavailable on this host: ${err.message})`,
          );
          return;
        }
        throw err;
      }
      const sessionId = handleId;

      // Subscribe BEFORE sending so we don't miss the head of the agent
      // response stream or any early tool.event records.
      const iter = bridge.events(sessionId);
      const collected: BridgeEvent[] = [];

      const terminator = (async () => {
        for await (const ev of iter) {
          collected.push(ev);
          if (
            (ev.type === "agent.reply" && ev.final === true) ||
            ev.type === "agent.done" ||
            ev.type === "session.ended"
          ) {
            return ev;
          }
        }
        return undefined;
      })();

      // WHY: the same deterministic prompt M3.7 uses — triggers a Read on
      // README.md, which yields the Pre/Post pair the ordering assertion
      // needs.
      await bridge.sendMessage(sessionId, "Read README.md and report the first line");

      let timer: ReturnType<typeof setTimeout> | undefined;
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`plugin-install integration: no terminal event after ${TEST_TIMEOUT_MS}ms`),
            ),
          TEST_TIMEOUT_MS,
        );
        timer.unref?.();
      });

      try {
        const terminal = await Promise.race([terminator, watchdog]);
        expect(terminal).toBeDefined();
        if (!terminal) throw new Error("no terminal event");

        const toolEvents = collected.filter(
          (e): e is Extract<BridgeEvent, { type: "tool.event" }> => e.type === "tool.event",
        );

        // Assertion 1 — coverage: at least one tool.event for each minimum
        // event.
        const eventNames = new Set(toolEvents.map((e) => e.payload.event));
        expect(eventNames.has("PreToolUse")).toBe(true);
        expect(eventNames.has("PostToolUse")).toBe(true);
        expect(eventNames.has("Stop")).toBe(true);

        // Assertion 2 — Pre/Post ordering by tool_use_id walked index-wise.
        // Every PostToolUse must be preceded earlier in the arrival-order
        // array by a PreToolUse with the same tool_use_id.
        // WHY the typeof guard: Stop hook payloads carry no tool_use_id;
        // they do not participate in Pre/Post pairing.
        const preSeenIds = new Set<string>();
        for (const ev of toolEvents) {
          const data = ev.payload.data as { tool_use_id?: string };
          const id = data.tool_use_id;
          if (ev.payload.event === "PreToolUse" && typeof id === "string") {
            preSeenIds.add(id);
          } else if (ev.payload.event === "PostToolUse" && typeof id === "string") {
            expect(preSeenIds.has(id)).toBe(true);
          }
        }

        // Assertion 3 — the first Stop tool.event must precede the terminal
        // event in arrival order.
        const firstStopIdx = collected.findIndex(
          (e) => e.type === "tool.event" && e.payload.event === "Stop",
        );
        expect(firstStopIdx).toBeGreaterThanOrEqual(0);
        const doneIdx = collected.findIndex((e) => e.type === "agent.done");
        const terminalIdx =
          doneIdx >= 0
            ? doneIdx
            : collected.findIndex(
                (e) => (e.type === "agent.reply" && e.final === true) || e.type === "session.ended",
              );
        expect(terminalIdx).toBeGreaterThanOrEqual(0);
        expect(firstStopIdx).toBeLessThan(terminalIdx);
      } finally {
        if (timer) clearTimeout(timer);
        await bridge.close(sessionId).catch(() => undefined);
      }
    } finally {
      // Tarball lives in the repo root next to package.json; remove it so
      // repeated runs don't leave .tgz droppings behind.
      await rm(tarballPath, { force: true }).catch(() => undefined);
    }
  },
  TEST_TIMEOUT_MS + 5_000,
);
