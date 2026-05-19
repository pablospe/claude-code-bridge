import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, type BridgeEvent } from "@ccb/core";
import { LauncherUnavailableError } from "@ccb/process";
import { claudeCodeSupervisorFactory } from "./claude-supervisor.ts";

/**
 * End-to-end smoke against a real `claude` binary with the hook relay
 * registered. Gated on CCB_RUN_REAL_CLAUDE=1 with the same preconditions as
 * `claude-supervisor.integration.test.ts`:
 *   - the `claude` CLI on PATH
 *   - authenticated credentials (the user has run `claude login` once)
 *   - `tengu_harbor` enabled so the dev-channels flag is honored
 *   - a host where node-pty can be loaded
 *
 * Asserts the three M3.7 guarantees in docs/M3.md:
 *   1. At least one tool.event for each minimum event (PreToolUse, PostToolUse, Stop).
 *   2. Pre/Post ordering by tool_use_id walked index-wise (not just set membership).
 *   3. The first Stop tool.event arrives before the terminal event.
 *
 * The test must NOT fail on a stock Bun host that cannot load node-pty —
 * it skips with a clear console.log notice so casual `bun test` stays green.
 */

const RUN_REAL_CLAUDE = process.env.CCB_RUN_REAL_CLAUDE === "1";
// WHY: hook fires add per-tool overhead and the deterministic prompt forces
// at least one Read; 120s is conservative compared to the 60s plain-ping
// integration test budget.
const TEST_TIMEOUT_MS = 120_000;

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-claude-hooks-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test(
  "managed launch with hooks: tool.event records cover PreToolUse/PostToolUse/Stop in order",
  async () => {
    if (!RUN_REAL_CLAUDE) {
      console.log(
        "claude-supervisor hooks integration: skipped (set CCB_RUN_REAL_CLAUDE=1 to run against real claude)",
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

    let handleId: string | undefined;
    try {
      const handle = await bridge.startSession({});
      handleId = handle.id;
    } catch (err) {
      if (err instanceof LauncherUnavailableError) {
        console.log(
          `claude-supervisor hooks integration: skipped (node-pty unavailable on this host: ${err.message})`,
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

    // WHY: the M3.md spec recommends this exact prompt — it deterministically
    // triggers a Read tool call on README.md, which yields the Pre/Post pair
    // the ordering assertion needs.
    await bridge.sendMessage(sessionId, "Read README.md and report its first line");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`hooks integration: no terminal event after ${TEST_TIMEOUT_MS}ms`)),
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

      // Assertion 1 — coverage: at least one tool.event for each minimum event.
      const eventNames = new Set(toolEvents.map((e) => e.payload.event));
      expect(eventNames.has("PreToolUse")).toBe(true);
      expect(eventNames.has("PostToolUse")).toBe(true);
      expect(eventNames.has("Stop")).toBe(true);

      // Assertion 2 — Pre/Post ordering by tool_use_id walked index-wise.
      // Every PostToolUse must be preceded earlier in the arrival-order array
      // by a PreToolUse with the same tool_use_id. Set-based membership over
      // the linear walk catches out-of-order frames as well as missing pairs.
      // WHY the typeof guard: Stop hook payloads carry no tool_use_id; they
      // do not participate in Pre/Post pairing.
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
      // event in arrival order. If agent.done is present, compare against it;
      // otherwise compare against whichever terminal event (agent.reply final
      // or session.ended) closed the stream.
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
  },
  TEST_TIMEOUT_MS + 5_000,
);
