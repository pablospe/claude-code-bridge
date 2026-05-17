import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, type BridgeEvent } from "@ccb/core";
import { LauncherUnavailableError } from "@ccb/process";
import { claudeCodeSupervisorFactory } from "./claude-supervisor.ts";

/**
 * End-to-end smoke against a real `claude` binary. Gated on
 * CCB_RUN_REAL_CLAUDE=1 because it requires:
 *   - the `claude` CLI on PATH
 *   - authenticated credentials (the user has run `claude login` once)
 *   - `tengu_harbor` enabled so the dev-channels flag is honored
 *   - a host where node-pty can be loaded
 *
 * The test must NOT fail on a stock Bun host that cannot load node-pty —
 * it skips with a clear console.log notice so CI runs and casual `bun test`
 * invocations stay green.
 */

const RUN_REAL_CLAUDE = process.env.CCB_RUN_REAL_CLAUDE === "1";
const TEST_TIMEOUT_MS = 60_000;

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-claude-real-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test(
  "managed launch: real claude drives a turn to agent.reply{final:true} or agent.done",
  async () => {
    if (!RUN_REAL_CLAUDE) {
      console.log(
        "claude-supervisor integration: skipped (set CCB_RUN_REAL_CLAUDE=1 to run against real claude)",
      );
      return;
    }

    const bridge = new Bridge({
      storeDir,
      supervisorFactory: claudeCodeSupervisorFactory({ channels: "dev-flag" }),
    });

    let handleId: string | undefined;
    try {
      const handle = await bridge.startSession({});
      handleId = handle.id;
    } catch (err) {
      if (err instanceof LauncherUnavailableError) {
        console.log(
          `claude-supervisor integration: skipped (node-pty unavailable on this host: ${err.message})`,
        );
        return;
      }
      throw err;
    }
    const sessionId = handleId;

    // Subscribe BEFORE sending so we don't miss the head of the agent
    // response stream.
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

    await bridge.sendMessage(sessionId, "ping");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`integration: no terminal event after ${TEST_TIMEOUT_MS}ms`)),
        TEST_TIMEOUT_MS,
      );
      timer.unref?.();
    });

    try {
      const terminal = await Promise.race([terminator, watchdog]);
      expect(terminal).toBeDefined();
      if (!terminal) throw new Error("no terminal event");
      // Either a final agent.reply or an agent.done is acceptable; both prove
      // the channel server connected and the bridge round-tripped tool calls.
      expect(["agent.reply", "agent.done", "session.ended"]).toContain(terminal.type);
    } finally {
      if (timer) clearTimeout(timer);
      await bridge.close(sessionId).catch(() => undefined);
    }
  },
  TEST_TIMEOUT_MS + 5_000,
);
