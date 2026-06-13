import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MockSupervisor } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { createAllowlistPolicy } from "./permission-policy.ts";
import { SessionPool } from "./pool.ts";

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

  test("close() rejects queued waiters instead of stranding them", async () => {
    const bridge = makeBridge([]);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    // Occupy the only session with a gated turn.
    const first = pool.withSession(async () => {
      await gate;
    });
    // Let the first turn acquire the session before queuing the second.
    await new Promise((r) => setTimeout(r, 20));
    // This second turn has no session available and queues as a waiter.
    // Capture its outcome synchronously so the rejection is always handled,
    // even though close() rejects it before we await below.
    const secondError = pool
      .withSession(async () => {})
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    await pool.close();
    expect(String(await secondError)).toMatch(/pool is closed/);
    releaseFirst();
    await first;
  });

  test("respawn failure rejects queued waiters", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    // Reject startSession after the initial pool warm-up so the post-crash
    // respawn fails.
    let startCalls = 0;
    const realStart = bridge.startSession.bind(bridge);
    bridge.startSession = ((options) => {
      startCalls += 1;
      if (startCalls > 1) {
        return Promise.reject(new Error("startSession boom"));
      }
      return realStart(options);
    }) as typeof bridge.startSession;

    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    // First turn holds the session, then crashes it once the gate opens.
    const first = pool.withSession(async () => {
      await gate;
      supervisors[0]?.triggerCrash();
      throw new Error("turn failed: session crashed");
    });
    // Let the first turn acquire the session before queuing the second.
    await new Promise((r) => setTimeout(r, 20));
    // Second turn queues as a waiter; the failed respawn must reject it.
    // Capture its outcome synchronously so the rejection is always handled,
    // even though the respawn failure rejects it before we await below.
    const secondError = pool
      .withSession(async () => {})
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    releaseFirst();
    await expect(first).rejects.toThrow("turn failed");
    expect(String(await secondError)).toMatch(/respawn failed/);
    await pool.close();
  });

  test("start() closes already-warmed sessions if a later warm-up fails", async () => {
    const bridge = makeBridge([]);
    const closed: string[] = [];
    const realStart = bridge.startSession.bind(bridge);
    const realClose = bridge.close.bind(bridge);
    bridge.close = ((sessionId: string) => {
      closed.push(sessionId);
      return realClose(sessionId);
    }) as typeof bridge.close;
    // First warm-up succeeds; the second rejects, leaking the first unless
    // start() cleans up.
    let startCalls = 0;
    let firstId = "";
    bridge.startSession = ((options) => {
      startCalls += 1;
      if (startCalls > 1) return Promise.reject(new Error("startSession boom"));
      return realStart(options).then((res) => {
        firstId = res.id;
        return res;
      });
    }) as typeof bridge.startSession;

    const pool = new SessionPool({ bridge, size: 2 });
    await expect(pool.start()).rejects.toThrow("startSession boom");
    expect(closed).toContain(firstId);
  });

  test("close() closes a session checked out by an in-flight turn", async () => {
    const bridge = makeBridge([]);
    const closed: string[] = [];
    const realClose = bridge.close.bind(bridge);
    bridge.close = ((sessionId: string) => {
      closed.push(sessionId);
      return realClose(sessionId);
    }) as typeof bridge.close;

    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let heldId = "";
    const first = pool
      .withSession(async (sessionId) => {
        heldId = sessionId;
        await gate;
      })
      .then(
        () => undefined,
        () => undefined,
      );
    // Let the turn acquire the session, then close the pool while it is held.
    await new Promise((r) => setTimeout(r, 20));
    await pool.close();
    // close() must have closed the checked-out session, not deferred it.
    expect(closed).toContain(heldId);
    releaseFirst();
    await first;
  });

  test("a turn in flight at close() time gets its session closed on release", async () => {
    const bridge = makeBridge([]);
    const closed: string[] = [];
    const realClose = bridge.close.bind(bridge);
    bridge.close = ((sessionId: string) => {
      closed.push(sessionId);
      return realClose(sessionId);
    }) as typeof bridge.close;

    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let heldId = "";
    const first = pool.withSession(async (sessionId) => {
      heldId = sessionId;
      await gate;
    });
    // Let the turn acquire the session, then close the pool around it.
    await new Promise((r) => setTimeout(r, 20));
    await pool.close();
    releaseFirst();
    await first;
    // The release path must close the session itself: close() already
    // drained #idle, so parking it there would leak it.
    expect(closed).toContain(heldId);
  });

  test("pool answers permission.requested via the policy", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({
      bridge,
      size: 1,
      permissionPolicy: createAllowlistPolicy(["Read"]),
    });
    await pool.start();
    const sup = supervisors[0];
    if (!sup) throw new Error("no supervisor");
    sup.triggerPermissionRequest("abcde", "Read");
    sup.triggerPermissionRequest("fghij", "Bash");
    await until(() => sup.respondCalls.length === 2);
    expect(sup.respondCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "abcde", behavior: "allow" }),
        expect.objectContaining({ requestId: "fghij", behavior: "deny" }),
      ]),
    );
    await pool.close();
  });

  test("a respawned session is watched too", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({
      bridge,
      size: 1,
      permissionPolicy: createAllowlistPolicy("all"),
    });
    await pool.start();
    await pool
      .withSession(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    await until(() => supervisors.length === 2);
    const fresh = supervisors[1];
    if (!fresh) throw new Error("no respawned supervisor");
    fresh.triggerPermissionRequest("abcde", "Bash");
    await until(() => fresh.respondCalls.length === 1);
    expect(fresh.respondCalls[0]).toMatchObject({ requestId: "abcde", behavior: "allow" });
    await pool.close();
  });

  test("pool without a policy ignores permission events", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    const sup = supervisors[0];
    if (!sup) throw new Error("no supervisor");
    sup.triggerPermissionRequest("abcde", "Bash");
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.respondCalls).toEqual([]);
    await pool.close();
  });
});
