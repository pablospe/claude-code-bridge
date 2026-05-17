import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeEvent } from "./events.ts";
import { Bridge, StartTimeoutError } from "./index.ts";
import type { Supervisor, SupervisorContext } from "./supervisor.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccb-bridge-start-timeout-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Supervisor whose `start` never resolves; tracks whether `close` was called. */
class HangingSupervisor implements Supervisor {
  closeCalled = false;
  async start(_ctx: SupervisorContext): Promise<void> {
    return new Promise<void>(() => {
      // never resolves
    });
  }
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalled = true;
  }
}

/** Supervisor whose `start` resolves after a controllable delay. */
class SlowStartSupervisor implements Supervisor {
  constructor(private delayMs: number) {}
  async start(_ctx: SupervisorContext): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

test("startSession rejects with StartTimeoutError when supervisor.start hangs", async () => {
  const supervisor = new HangingSupervisor();
  const bridge = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    startTimeoutMs: 50,
  });

  const t0 = Date.now();
  await expect(bridge.startSession({})).rejects.toBeInstanceOf(StartTimeoutError);
  const elapsed = Date.now() - t0;
  // Allow generous slack for CI jitter but assert we did not wait near the default 30s.
  expect(elapsed).toBeLessThan(2_000);
});

test("startSession timeout runs the failed-start cleanup path", async () => {
  const supervisor = new HangingSupervisor();
  const bridge = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    startTimeoutMs: 50,
  });

  await expect(bridge.startSession({})).rejects.toBeInstanceOf(StartTimeoutError);

  // supervisor.close was invoked as part of cleanup.
  expect(supervisor.closeCalled).toBe(true);

  // No leftover JSONL file on disk.
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  );
  expect(files).toHaveLength(0);

  // No leftover session in the internal map: sending to any id must reject as unknown.
  await expect(bridge.sendMessage("00000000-0000-0000-0000-000000000000", "x")).rejects.toThrow(
    /unknown session/,
  );
});

test("startSession timeout: events() for a never-started session returns empty iterable", async () => {
  const supervisor = new HangingSupervisor();
  const bridge = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    startTimeoutMs: 50,
  });

  // Capture the id the bridge minted by hooking into the supervisor's ctx; the
  // hanging supervisor never receives one, so instead we just exercise the
  // facade: a random UUID must yield an empty iterable.
  const sub = bridge.events("11111111-1111-1111-1111-111111111111");
  const seen: BridgeEvent[] = [];
  for await (const e of sub) {
    seen.push(e);
  }
  expect(seen).toEqual([]);

  // Also: bridge.close on an unknown id is a no-op.
  await expect(bridge.close("11111111-1111-1111-1111-111111111111")).resolves.toBeUndefined();

  // And the hanging start must still reject so the test does not hang.
  await expect(bridge.startSession({})).rejects.toBeInstanceOf(StartTimeoutError);
});

test("startSession with a slow supervisor succeeds when startTimeoutMs is forgiving", async () => {
  const supervisor = new SlowStartSupervisor(200);
  const bridge = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    startTimeoutMs: 1_000,
  });

  const handle = await bridge.startSession({});
  expect(typeof handle.id).toBe("string");
  await bridge.close(handle.id);
});
