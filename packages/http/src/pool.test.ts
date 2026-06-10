import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MockSupervisor } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { SessionPool } from "./pool.ts";

const storeDir = `/tmp/ccb-pool-test-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

function makeBridge(supervisors: MockSupervisor[]): Bridge {
  return new Bridge({
    storeDir,
    supervisorFactory: () => {
      const s = new MockSupervisor();
      supervisors.push(s);
      return s;
    },
  });
}

describe("SessionPool", () => {
  test("clears the session before handing it to the turn", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    await pool.withSession(async () => {});
    expect(supervisors[0]?.clearCalls).toBe(1);
    await pool.close();
  });

  test("serializes concurrent turns on a size-1 pool (FIFO)", async () => {
    const bridge = makeBridge([]);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = pool.withSession(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = pool.withSession(async () => {
      order.push("second-start");
    });
    // Give the second a chance to (incorrectly) start early.
    await new Promise((r) => setTimeout(r, 20));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    await pool.close();
  });

  test("a turn failure respawns a fresh session and the pool keeps serving", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    await expect(
      pool.withSession(async () => {
        supervisors[0]?.triggerCrash();
        throw new Error("turn failed: session crashed");
      }),
    ).rejects.toThrow("turn failed");
    // The pool replaced the crashed session; a new turn works.
    await pool.withSession(async (sessionId) => {
      expect(typeof sessionId).toBe("string");
    });
    expect(supervisors.length).toBe(2);
    await pool.close();
  });
});
