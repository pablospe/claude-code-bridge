# OpenClaw ACP ↔ ccb Bridge — Implementation Plan

> **For agentic workers:** TDD, frequent commits, exact paths. Spec:
> `docs/2026-06-04-openclaw-claude-bridge-acp-backend-design.md`.

**Goal:** Power an OpenClaw agent with a genuine interactive Claude Code session (Max
subscription) via a custom ACP runtime backend that embeds the ccb library.

**Architecture:** New workspace package `packages/openclaw-acp/` in the ccb monorepo. It
implements OpenClaw's `AcpRuntime` interface by driving ccb's `Bridge` (which spawns/supervises
`claude` via node-pty). Pure-type contracts are vendored so unit/integration tests run under
`bun:test` with no OpenClaw dependency; only `src/index.ts` (the OpenClaw plugin entry) imports
the real `openclaw/plugin-sdk/*`.

**Tech Stack:** TypeScript ESM, Bun workspace, `bun:test`, `@ccb/core` + `@ccb/claude-code`.

**Runtime facts (verified):** Node 24.14.1, Bun 1.3.14, `claude` 2.1.163 authed (Max), ccb
baseline 332 tests green, real-claude managed launch works on this host.

**Package location note:** spec said `plugins/openclaw-acp/`; using `packages/openclaw-acp/`
instead because ccb's bun `workspaces` globs are `packages/*` + `apps/*` only, and `plugins/`
holds a Claude-Code plugin dir with no package.json. Lower-risk than editing workspace globs.

---

## Test layers (definition of "working")

- **L1** ccb Node-compat patch — `JsonlEventStore.readAll` runs under Node + Bun.
- **L2** `translateBridgeEvent` unit tests (every BridgeEvent variant).
- **L3** adapter passes a vendored copy of OpenClaw's `runAcpRuntimeAdapterContract`.
- **L4** adapter ⇄ ccb `mockSupervisorFactory` end-to-end.
- **L5** adapter ⇄ real `claude` (managed launch), gated by `CCB_RUN_REAL_CLAUDE=1`.
- **L6** OpenClaw gateway wiring (plugin install + config) — attempt + document.

---

## Task 1 (L1): ccb Node-compat patch

**Files:** Modify `packages/core/src/store.ts:36-41`; Test `packages/core/src/store.node.test.ts` (new).

`readAll()` currently uses `Bun.file(this.#path)` → `ReferenceError` on Node. Writes already use
`node:fs` `createWriteStream`. Replace the read with `node:fs/promises`:

```ts
// top of file: add
import { readFile } from "node:fs/promises";

// readAll(): replace the Bun.file block (lines 37-44) with:
let text: string;
try {
  text = await readFile(this.#path, "utf8");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
  throw err;
}
if (text.length === 0) return [];
```

- Run `bun test packages/core/src/store.test.ts` → still green (existing readAll tests).
- New `store.node.test.ts` proves it under Node: spawn `node --input-type=module` evaluating a
  tiny script that imports the built `dist/index.js`? Simpler: a bun test that asserts the
  source has no `Bun.` in `readAll` is weak. Instead: build (`bun run build`) then
  `node -e` load `dist/index.js` and exercise `JsonlEventStore.readAll`. (See Task 7 for the
  Node smoke harness; L1's node proof folds into it.)
- Commit: `fix(core): make JsonlEventStore.readAll Node-compatible`.

## Task 2: package scaffold

**Files:** `packages/openclaw-acp/package.json`, `tsconfig.json`, `src/index.ts` placeholder.

`package.json`:
```json
{
  "name": "@pablospe/openclaw-acp-claude-bridge",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@ccb/core": "workspace:*",
    "@ccb/claude-code": "workspace:*"
  }
}
```
- `bun install` at root to link. Commit.

## Task 3 (vendored contracts): `src/acp-contract.ts`

Verbatim copy of the pure types from OpenClaw `packages/acp-core/src/runtime/types.ts`
(AcpRuntime, AcpRuntimeHandle, AcpRuntimeEnsureInput, AcpRuntimeTurnInput, AcpRuntimeEvent,
AcpRuntimeTurn, AcpRuntimeTurnResult, AcpRuntimeTurnResultError, AcpRuntimeDoctorReport,
AcpRuntimeCapabilities, AcpRuntimeStatus, AcpRuntimePromptMode, AcpRuntimeSessionMode,
AcpSessionUpdateTag, AcpRuntimeControl). Types only — erased at runtime. Header comment notes
the source + that it must track the SDK contract.

## Task 4 (L2): `src/translator.ts` + `translator.test.ts`

Pure function `translateBridgeEvent(ev: BridgeEvent): TranslateResult` where
`TranslateResult = { events: AcpRuntimeEvent[]; terminal: AcpRuntimeTurnResult | null }`.
Mapping (from T3 sketch + verified BridgeEvent union):
- `agent.progress` → `[{type:"text_delta", text: ev.content, stream:"output"}]`, terminal null
- `agent.reply` → `[{type:"text_delta", text: ev.content, stream:"output"}]`; if `ev.final`
  also push `{type:"done"}` and terminal `{status:"completed"}`
- `agent.done` → `[{type:"done", stopReason: ev.reason}]`, terminal `{status:"completed"}`
- `tool.event`: PreToolUse → `[{type:"tool_call", text: name, status:"in_progress", title:name}]`;
  PostToolUse → `[{type:"tool_call", text:name, status:"completed", title:name}]`; Stop → `[]`
- `session.ended` → if `reason` looks like crash, `[{type:"error", message: reason}]` + terminal
  `{status:"failed", error:{message: reason}}`; else `[{type:"done"}]` + `{status:"completed"}`
- `session.started`, `message.sent`, `agent.input_requested` → `[]`, terminal null
Tests: one per variant; assert events + terminal.

## Task 5 (L3+L4): `src/adapter.ts` + `adapter.mock.test.ts`

`createClaudeBridgeRuntime(opts: { bridge: ClaudeCodeBridge; backendId?: string }): AcpRuntime`.
- `ensureSession`: `bridge.startSession({})`; start ONE long-lived `bridge.events(id)` pump into
  a per-session router; return handle `{ sessionKey, backend:"claude-bridge",
  runtimeSessionName: ccbId, backendSessionId: ccbId }`.
- `startTurn`: open a fresh per-turn async channel set as active; `bridge.sendMessage(id,text)`;
  return `{ requestId, events: drain(channel), result: terminalPromise, cancel, closeStream }`.
  Router feeds the active turn's channel; on `terminal` it closes the channel + resolves result.
- `runTurn`: `async function*` delegating to `startTurn().events` (terminal `done` is in-stream).
- `cancel`: `bridge.interrupt(id)`. `close`: `bridge.close(id)` + stop pump.
- `doctor`: `{ ok:true, message:"claude-bridge ready" }`.
Tests use `mockSupervisorFactory()` (echoes progress→reply{final}→done). Include a vendored
conformance test mirroring `runAcpRuntimeAdapterContract` assertions (handle non-empty, a `done`
event, cancel/close resolve).

## Task 6 (L5): `src/adapter.real.test.ts` (gated)

`if (!process.env.CCB_RUN_REAL_CLAUDE) test.skip(...)`. Build a Bridge with
`claudeCodeSupervisorFactory({ channels:"dev-flag", hooks:{events:["PreToolUse","PostToolUse","Stop"]} })`,
wrap in adapter, `ensureSession` then `startTurn({text:"What is 11 squared? Reply with just the number."})`,
collect events, assert a `text_delta` containing "121" and a terminal `completed`. Timeout 240s.

## Task 7 (L1 node proof + publish prep): build + Node smoke

Add a `bun build --target=node` bundle for the adapter (inlining `@ccb/*`) → `dist/`, and a Node
smoke (`scripts/node-smoke.mjs`) that loads the built bundle under `node` and runs the
mock-supervisor round-trip. Proves both the Node-compat patch (L1) and that the shippable bundle
loads under Node. Wire `openclaw.extensions` in package.json to the built entry for L6.

## Task 8 (L6): OpenClaw plugin entry + wiring

`src/index.ts` uses `definePluginEntry` + `registerAcpRuntimeBackend` from
`openclaw/plugin-sdk/*` (ambient-declared in `src/openclaw-sdk.d.ts` for monorepo typecheck).
Add `openclaw.plugin.json` manifest (`id:"claude-bridge"`, `activation.onStartup:true`,
`configSchema`) and `openclaw` block in package.json. Attempt install into the host OpenClaw +
set `acp.backend:"claude-bridge"` on a non-sandboxed agent; document exact steps + any blockers.

## Verification commands

- `cd ~/code/ccb-openclaw-acp && bun test packages/openclaw-acp` (L2–L4)
- `CCB_RUN_REAL_CLAUDE=1 bun test packages/openclaw-acp/src/adapter.real.test.ts` (L5)
- `bun run build && node scripts/node-smoke.mjs` (L1 node + bundle)
- Full: `bun test` (no regressions).
