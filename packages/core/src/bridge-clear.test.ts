import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { Bridge } from "./bridge.ts";
import type { Supervisor, SupervisorContext } from "./supervisor.ts";

const storeDir = `/tmp/ccb-clear-test-${crypto.randomUUID()}`;

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

// Local stub mirroring bridge.test.ts's StubSupervisor, plus a clearCalls seam.
// A cross-package import of MockSupervisor would make @ccb/core depend on
// @ccb/claude-code, which already depends on @ccb/core (a cycle).
class ClearSupervisor implements Supervisor {
  ctx: SupervisorContext | undefined;
  clearCalls = 0;

  async start(ctx: SupervisorContext): Promise<void> {
    this.ctx = ctx;
  }

  async sendMessage(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async clear(sessionId: string): Promise<void> {
    if (sessionId !== this.ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    this.clearCalls += 1;
  }

  async close(): Promise<void> {}
}

describe("Bridge.clear", () => {
  test("delegates to a supervisor that supports clear", async () => {
    const supervisor = new ClearSupervisor();
    const bridge = new Bridge({ storeDir, supervisorFactory: () => supervisor });
    const { id } = await bridge.startSession({});
    await bridge.clear(id);
    expect(supervisor.clearCalls).toBe(1);
    await bridge.close(id);
  });

  test("rejects for unknown session", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: () => new ClearSupervisor() });
    await expect(bridge.clear("nope")).rejects.toThrow();
  });

  test("rejects when the supervisor does not implement clear", async () => {
    const supervisor = new ClearSupervisor();
    // Simulate a supervisor without clear support.
    (supervisor as unknown as Record<string, unknown>).clear = undefined;
    const bridge = new Bridge({ storeDir, supervisorFactory: () => supervisor });
    const { id } = await bridge.startSession({});
    await expect(bridge.clear(id)).rejects.toThrow("does not support clear");
    await bridge.close(id);
  });

  test("clear during close rejects with 'closing'", async () => {
    class SlowCloseSupervisor implements Supervisor {
      async start(): Promise<void> {}
      async sendMessage(): Promise<void> {}
      async interrupt(): Promise<void> {}
      async clear(): Promise<void> {}
      async close(): Promise<void> {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    const bridge = new Bridge({
      storeDir,
      supervisorFactory: () => new SlowCloseSupervisor(),
    });
    const { id } = await bridge.startSession({});

    const closing = bridge.close(id);
    // yield so close sets state to "closing"
    await new Promise((r) => setTimeout(r, 5));
    await expect(bridge.clear(id)).rejects.toThrow(/closing/);
    await closing;
  });
});
