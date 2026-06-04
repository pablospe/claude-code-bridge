/**
 * Node smoke. Bundled with `bun build --target=node` and run under the `node`
 * binary (not Bun) to prove the runtime path — including the Node-compat
 * JsonlEventStore.readAll patch — works on Node, which is what OpenClaw uses.
 *
 * Uses the mock supervisor (no real claude). Exits 0 on success, 1 on failure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "@ccb/core";
import { mockSupervisorFactory } from "@ccb/claude-code";
import type { AcpRuntimeEvent } from "./acp-contract.ts";
import { createClaudeBridgeRuntime } from "./adapter.ts";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ocacp-nodesmoke-"));
  const bridge = new Bridge({ storeDir: dir, supervisorFactory: mockSupervisorFactory() });
  const rt = createClaudeBridgeRuntime({ bridge });
  try {
    const handle = await rt.ensureSession({ sessionKey: "smoke", agent: "test", mode: "persistent" });
    const turn = rt.startTurn?.({ handle, text: "hello-node", mode: "prompt", requestId: "s1" });
    if (!turn) throw new Error("startTurn missing");

    const events: AcpRuntimeEvent[] = [];
    for await (const ev of turn.events) events.push(ev);
    const result = await turn.result;

    const text = events
      .filter((e): e is Extract<AcpRuntimeEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");

    // Exercise JsonlEventStore.readAll (the patched Node path) directly.
    const stored = await bridge.readStoredEvents(handle.runtimeSessionName);

    if (result.status !== "completed") throw new Error(`expected completed, got ${result.status}`);
    if (!text.includes("hello-node")) throw new Error(`reply missing echo: ${JSON.stringify(text)}`);
    if (stored.length === 0) throw new Error("readStoredEvents returned no events (store read failed)");

    console.log(
      `NODE SMOKE OK: result=${result.status} text=${JSON.stringify(text)} storedEvents=${stored.length}`,
    );
    await rt.close({ handle, reason: "smoke" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("NODE SMOKE FAILED:", err);
    process.exit(1);
  },
);
