import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "@ccb/core";
import { claudeCodeSupervisorFactory } from "@ccb/claude-code";
import { LauncherUnavailableError } from "@ccb/process";
import type { AcpRuntimeEvent } from "./acp-contract.ts";
import { createClaudeBridgeRuntime } from "./adapter.ts";

/**
 * L5 — the money proof: a real interactive `claude` (Max subscription) driven
 * through the ACP adapter produces a reply. Gated on CCB_RUN_REAL_CLAUDE=1
 * (needs the authed `claude` CLI, channels eligibility, and a node-pty host).
 * Skips cleanly otherwise so casual `bun test` stays green.
 */

const RUN_REAL_CLAUDE = process.env.CCB_RUN_REAL_CLAUDE === "1";
const TEST_TIMEOUT_MS = 180_000;

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ocacp-real-"));
});
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test(
  "real claude: a turn round-trips through the ACP adapter to a completed result",
  async () => {
    if (!RUN_REAL_CLAUDE) {
      console.log(
        "openclaw-acp real integration: skipped (set CCB_RUN_REAL_CLAUDE=1 to run against real claude)",
      );
      return;
    }

    const bridge = new Bridge({
      storeDir,
      supervisorFactory: claudeCodeSupervisorFactory({
        channels: "dev-flag",
        hooks: { events: ["PreToolUse", "PostToolUse", "Stop"] },
      }),
    });
    const rt = createClaudeBridgeRuntime({ bridge });

    let handle: Awaited<ReturnType<typeof rt.ensureSession>>;
    try {
      handle = await rt.ensureSession({ sessionKey: "real-1", agent: "test", mode: "persistent" });
    } catch (err) {
      if (err instanceof LauncherUnavailableError) {
        console.log(`openclaw-acp real integration: skipped (node-pty unavailable: ${err.message})`);
        return;
      }
      throw err;
    }

    const turn = rt.startTurn?.({
      handle,
      text: "What is 11 squared? Reply with only the number.",
      mode: "prompt",
      requestId: "real-r1",
    });
    if (!turn) throw new Error("startTurn missing");

    const events: AcpRuntimeEvent[] = [];
    const watchdog = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no terminal result after ${TEST_TIMEOUT_MS}ms`)),
        TEST_TIMEOUT_MS,
      );
      t.unref?.();
    });

    try {
      const drain = (async () => {
        for await (const ev of turn.events) events.push(ev);
        return turn.result;
      })();
      const result = await Promise.race([drain, watchdog]);

      // The turn ended cleanly (completed) — the bridge round-tripped a reply.
      expect(result.status).toBe("completed");
      const text = events
        .filter((e): e is Extract<AcpRuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.text)
        .join("");
      expect(text.length).toBeGreaterThan(0);
      // Deterministic math so we can assert real model content, not just a round-trip.
      expect(text).toContain("121");
      console.log(`openclaw-acp real integration: claude replied -> ${JSON.stringify(text)}`);
    } finally {
      await rt.close({ handle, reason: "test" }).catch(() => {});
    }
  },
  TEST_TIMEOUT_MS + 10_000,
);
