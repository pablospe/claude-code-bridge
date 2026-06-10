import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge, type Supervisor } from "@ccb/core";
import { runTurn } from "./turn.ts";

// A supervisor that never emits a terminal event, so the turn timeout always
// wins. This makes the timeout assertion deterministic.
class SilentSupervisor implements Supervisor {
  async start(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

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
    const bridge = new Bridge({ storeDir, supervisorFactory: () => new SilentSupervisor() });
    const { id } = await bridge.startSession({});
    await expect(
      runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 50 }),
    ).rejects.toThrow(/turn timed out after 50ms/);
    await bridge.close(id);
  });
});
