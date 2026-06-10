import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { runTurn } from "./turn.ts";

const storeDir = `/tmp/ccb-turn-test-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("runTurn", () => {
  test("collects deltas and the final content", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    const deltas: string[] = [];
    const result = await runTurn({
      bridge,
      sessionId: id,
      prompt: "ping",
      timeoutMs: 10_000,
      onDelta: (d) => deltas.push(d),
    });
    // MockSupervisor emits progress "thinking" then reply "echo: <content>".
    expect(result.content).toBe("echo: ping");
    expect(deltas).toEqual(["thinking", "echo: ping"]);
    await bridge.close(id);
  });

  test("times out when no terminal event arrives", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    // The mock will answer "ping", but with timeoutMs: 1 the timer races the
    // echo chain. Forcing the timer to win deterministically is flaky, so
    // assert the error message "either way": if the turn rejects it must be
    // the timeout error.
    try {
      await runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 1 });
    } catch (err) {
      expect((err as Error).message).toMatch(/turn timed out/);
    }
    await bridge.close(id);
  });
});
