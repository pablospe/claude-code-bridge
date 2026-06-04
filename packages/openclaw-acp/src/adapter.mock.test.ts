import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "@ccb/core";
import { mockSupervisorFactory } from "@ccb/claude-code";
import type { AcpRuntimeEvent } from "./acp-contract.ts";
import { createClaudeBridgeRuntime } from "./adapter.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ocacp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function newBridge(): Bridge {
  return new Bridge({ storeDir: dir, supervisorFactory: mockSupervisorFactory() });
}

async function collect(iter: AsyncIterable<AcpRuntimeEvent>): Promise<AcpRuntimeEvent[]> {
  const out: AcpRuntimeEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

test("ensureSession returns a handle with backend and runtime session name", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const handle = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });
  expect(handle.sessionKey).toBe("s1");
  expect(handle.backend).toBe("claude-bridge");
  expect(handle.runtimeSessionName.trim().length).toBeGreaterThan(0);
  expect(handle.backendSessionId).toBe(handle.runtimeSessionName);
  await rt.close({ handle, reason: "test" });
});

test("ensureSession is idempotent for the same session key (no second claude)", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const a = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });
  const b = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });
  expect(b.runtimeSessionName).toBe(a.runtimeSessionName);
  await rt.close({ handle: a, reason: "test" });
});

test("startTurn round-trips a reply through the translator", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const handle = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });
  const turn = rt.startTurn?.({ handle, text: "hello", mode: "prompt", requestId: "r1" });
  if (!turn) throw new Error("startTurn missing");
  const events = await collect(turn.events);
  const result = await turn.result;

  expect(result).toEqual({ status: "completed" });
  expect(events.some((e) => e.type === "done")).toBe(true);
  const text = events
    .filter((e): e is Extract<AcpRuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  expect(text).toContain("hello");
  await rt.close({ handle, reason: "test" });
});

test("runTurn yields the same event stream including a terminal done", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const handle = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });
  const events = await collect(
    rt.runTurn({ handle, text: "world", mode: "prompt", requestId: "r1" }),
  );
  expect(events.some((e) => e.type === "done")).toBe(true);
  expect(events.some((e) => e.type === "text_delta")).toBe(true);
  await rt.close({ handle, reason: "test" });
});

test("two sequential turns each complete on the same session", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const handle = await rt.ensureSession({ sessionKey: "s1", agent: "test", mode: "persistent" });

  const t1 = rt.startTurn?.({ handle, text: "first", mode: "prompt", requestId: "r1" });
  if (!t1) throw new Error("startTurn missing");
  await collect(t1.events);
  expect(await t1.result).toEqual({ status: "completed" });

  const t2 = rt.startTurn?.({ handle, text: "second", mode: "prompt", requestId: "r2" });
  if (!t2) throw new Error("startTurn missing");
  const e2 = await collect(t2.events);
  expect(await t2.result).toEqual({ status: "completed" });
  const text2 = e2
    .filter((e): e is Extract<AcpRuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  expect(text2).toContain("second");
  await rt.close({ handle, reason: "test" });
});

// Vendored from openclaw src/acp/runtime/adapter-contract.testkit.ts
// (runAcpRuntimeAdapterContract). The testkit lives in openclaw core and is not
// re-exported via the plugin SDK, so we mirror its assertions here under bun:test.
test("passes the OpenClaw ACP adapter contract", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  const sessionKey = "contract";
  const handle = await rt.ensureSession({ sessionKey, agent: "codex", mode: "persistent" });

  expect(handle.sessionKey).toBe(sessionKey);
  expect(handle.backend.trim()).not.toHaveLength(0);
  expect(handle.runtimeSessionName.trim()).not.toHaveLength(0);

  const successEvents = await collect(
    rt.runTurn({ handle, text: "contract-success", mode: "prompt", requestId: "c1" }),
  );
  expect(
    successEvents.some(
      (e) =>
        e.type === "done" ||
        e.type === "text_delta" ||
        e.type === "status" ||
        e.type === "tool_call",
    ),
  ).toBe(true);
  expect(successEvents.some((e) => e.type === "done")).toBe(true);

  if (rt.getStatus) {
    const status = await rt.getStatus({ handle });
    expect(typeof status).toBe("object");
  }

  await rt.cancel({ handle, reason: "contract-cancel" });
  await rt.close({ handle, reason: "contract-close" });
});

test("doctor reports ok", async () => {
  const rt = createClaudeBridgeRuntime({ bridge: newBridge() });
  expect(await rt.doctor?.()).toEqual({ ok: true, message: "claude-bridge runtime ready" });
});
