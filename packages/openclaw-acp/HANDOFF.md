# HANDOFF: OpenClaw on a Claude Max subscription via claude-code-bridge

A complete, from-scratch brief for another agent (or human) to understand, build,
deploy, and finish this work with zero prior context. Pair this with the spec
(`docs/2026-06-04-openclaw-claude-bridge-acp-backend-design.md`) and plan
(`docs/2026-06-05-openclaw-acp-bridge-plan.md`). Status as of 2026-06-05; file:line
citations may drift — verify against current source.

---

## 1. The problem and why this design

**Goal:** make OpenClaw (a multi-channel agent gateway) run on a Claude **Pro/Max
subscription** instead of a paid Anthropic API key.

Three ways to use a Max subscription, and why two are dead:

1. **Replay the OAuth token** (`sk-ant-oat`) to Anthropic's API from a non-genuine
   client → **banned** (account flagging). OpenClaw's own Anthropic provider does
   exactly this with spoofed `claude-cli` headers (`openclaw/src/llm/providers/anthropic.ts`
   ~`:887`) — do not use it for this.
2. **`claude -p` / Agent SDK (headless)** → still the genuine binary, but as of
   **2026-06-15** headless/SDK usage stops drawing from the interactive subscription
   allowance and bills a **separate capped "Agent SDK credit."** The interactive
   allowance is reserved for *interactive* Claude Code / Cowork / chat.

**The only path that spends the interactive allowance from automation is to drive a
genuine, persistent, interactive `claude` session.** That is exactly what
[claude-code-bridge (ccb)](https://github.com/pablospe/claude-code-bridge) does: it
pushes messages into a running interactive `claude` over Anthropic's **channels** MCP
surface and reads structured replies via three MCP tools (`bridge_reply` /
`bridge_progress` / `bridge_done`). No token replay, no headless reclassification —
indistinguishable from a human using Claude Code.

**Consequence (the core constraint):** Claude Code is the *reasoner*. OpenClaw cannot be
the "brain" on Max quota — the interactive session is a full agent, not a raw model
endpoint. What OpenClaw keeps is its **session/turn/channel-routing** machinery; it
delegates "produce this turn's answer" to ccb.

---

## 2. Architecture

```
Telegram / Discord ──▶ OpenClaw gateway (on host, NOT sandboxed for this agent)
                          │  channel routing · session · turn lifecycle (UNCHANGED)
                          ▼  ACP manager.runTurn   (config.acp.backend = "claude-bridge")
                  this plugin: ACP runtime backend "claude-bridge"
                          │  embeds ccb Bridge + ClaudeCodeSupervisor
                          ▼  node-pty (no tmux)
                  genuine interactive `claude` (Max login) ── reasons, runs its own tools
```

Mechanism = a **custom OpenClaw ACP runtime backend**. OpenClaw's ACP layer is built to
delegate a turn to an external agent and stream structured events back — which maps 1:1
onto ccb's "push message in → progress/reply/done out". We register a backend named
`claude-bridge` via the public SDK seam; **no OpenClaw core changes, acpx untouched.**

Key design decisions (all settled):
- **External plugin**, not a bundled `extensions/` plugin — optional integrations route to
  plugins; keeps OpenClaw core plugin-agnostic.
- **Co-located in the ccb repo** (`packages/openclaw-acp/`) so it versions with the library
  it wraps.
- **ccb embedded as a Node library** (one Node-compat patch needed — see §6).
- **`ClaudeCodeSupervisor`** (ccb's node-pty managed launch) spawns/supervises `claude` →
  **no tmux**. Plugin `start()` builds the Bridge; the supervisor owns the process.
- **Gateway on host**, agent **non-sandboxed** (OpenClaw denies ACP when sandboxed), so
  `claude` + node-pty + the bridge's loopback control socket all colocate.

---

## 3. Repository layout (branch `feat/openclaw-acp-bridge`)

```
claude-code-bridge/                         # Pablo's ccb repo (Bun workspace)
├─ packages/core/src/store.ts               # PATCHED: readAll uses node:fs not Bun.file (L1)
├─ packages/openclaw-acp/                    # THE PLUGIN (new workspace package)
│  ├─ package.json                          # name @pablospe/openclaw-acp-claude-bridge; openclaw block; build scripts
│  ├─ openclaw.plugin.json                  # manifest: id "claude-bridge", activation.onStartup
│  ├─ tsconfig.json                         # composite; references @ccb/core,@ccb/claude-code,@ccb/process
│  ├─ README.md                             # how it works + status + L6 wiring
│  ├─ HANDOFF.md                            # this file
│  ├─ l6/openclaw.json                      # isolated-gateway test config (+ telegram acp binding)
│  ├─ l6/run-l6-smoke.sh                    # build openclaw + isolated gateway + send a turn
│  └─ src/
│     ├─ acp-contract.ts                    # VENDORED OpenClaw AcpRuntime types (pure types)
│     ├─ translator.ts                      # BridgeEvent -> AcpRuntimeEvent (pure fn)
│     ├─ adapter.ts                         # createClaudeBridgeRuntime(): AcpRuntime over ccb Bridge
│     ├─ index.ts                           # OpenClaw plugin entry (definePluginEntry + register backend)
│     ├─ openclaw-sdk.d.ts                  # ambient decls for openclaw/plugin-sdk/* (monorepo typecheck only)
│     ├─ smoke.ts                           # node-bundle smoke entry (proves Node runtime)
│     ├─ translator.test.ts                 # L2
│     ├─ adapter.mock.test.ts               # L3 (conformance) + L4 (mock supervisor e2e)
│     └─ adapter.real.test.ts               # L5 (real claude, gated by CCB_RUN_REAL_CLAUDE=1)
└─ docs/2026-06-04-...design.md, docs/2026-06-05-...plan.md
```

The OpenClaw checkout (`~/code/openclaw`, v2026.6.2) is **read-only context** — only its
config is touched at deploy time, never its code.

---

## 4. The contracts you must honor

### 4a. ccb library (consume these; do not reach past them)
From `@ccb/core` / `@ccb/claude-code` (public surface re-exported by ccb root `src/index.ts`):

- `class Bridge` implements `ClaudeCodeBridge`:
  - `startSession(opts): Promise<SessionHandle {id}>` — spawns/attaches a `claude` session.
  - `sendMessage(sessionId, content): Promise<string>` — pushes a turn.
  - `events(sessionId): AsyncIterable<BridgeEvent>` — **live tail from subscribe time**
    (subscribe before sending or you miss the head).
  - `interrupt(sessionId)`, `close(sessionId)`, `readStoredEvents(sessionId)`.
- `claudeCodeSupervisorFactory({ channels: "dev-flag"|"plugin", hooks?: {events: HookEvent[]} }): SupervisorFactory`
  — `ClaudeCodeSupervisor` spawns `claude` via node-pty. `HookEvent = "PreToolUse"|"PostToolUse"|"Stop"`.
- `mockSupervisorFactory()` — in-process echo (progress→reply{final}→done); used by tests.
- `CRASH_AGENT_DONE_REASON = "channel-disconnected"`, `CRASH_SESSION_ENDED_REASON = "supervisor crashed"`.

`BridgeEvent` union (`packages/core/src/events.ts`), every variant carries `sessionId`:
`session.started` · `message.sent{messageId,content}` · `agent.progress{content,messageId?}`
· `agent.reply{content,final,messageId?}` · `agent.done{reason?}` ·
`agent.input_requested{requestId,prompt}` · `tool.event{payload:{event,data}}` ·
`session.ended{reason?}`. **Turn ends on `agent.reply{final:true}` OR `agent.done`** (both
are terminal). ccb is MESSAGE-level, not token-level.

### 4b. OpenClaw ACP runtime (implement this)
Source: `openclaw/packages/acp-core/src/runtime/types.ts`; registration via
`openclaw/src/plugin-sdk/acp-runtime-backend.ts`. Vendored verbatim into
`src/acp-contract.ts` (pure types, so tests need no OpenClaw checkout).

`interface AcpRuntime` — required: `ensureSession`, `runTurn`, `cancel`, `close`.
Optional: `startTurn` (preferred — splits live `events` from terminal `result`),
`getCapabilities`, `getStatus`, `setMode`, `setConfigOption`, `doctor`, `prepareFreshSession`.
- `AcpRuntimeHandle` = opaque `{ sessionKey, backend, runtimeSessionName, backendSessionId?, ... }`
  (no PID — backend need not own a process tree).
- `AcpRuntimeEvent` = `text_delta{stream?:"output"|"thought"}` | `status` | `tool_call{status,title}`
  | `done{stopReason?}` | `error{message,code?,retryable?}`.
- `AcpRuntimeTurn` = `{ requestId, events: AsyncIterable, result: Promise<AcpRuntimeTurnResult>, cancel(), closeStream() }`.
- `AcpRuntimeTurnResult` = `{status:"completed"|"cancelled"|"failed", ...}`.

Registration seam: `registerAcpRuntimeBackend({ id, runtime, healthy? })` /
`unregisterAcpRuntimeBackend(id)` from `openclaw/plugin-sdk/acp-runtime-backend`. The
`{id,runtime,healthy}` record type is NOT exported — build the literal inline. Ids are
lowercased in the registry; `config.acp.backend` is a free `string`
(`openclaw/src/config/types.acp.ts`), so id `"claude-bridge"` needs no core change.

Plugin entry: `definePluginEntry({ id, name, description, register(api) })` from
`openclaw/plugin-sdk/plugin-entry`; `api.registerService({ id, start(ctx), stop(ctx) })`.
`ctx.stateDir`/`ctx.logger` available in `start`. Manifest `openclaw.plugin.json` MUST set
`activation.onStartup:true` for a startup-registered backend.

### 4c. The translation (heart of the adapter)
`translator.ts` maps each `BridgeEvent` → `{ events: AcpRuntimeEvent[]; terminal: AcpRuntimeTurnResult|null }`:
- `agent.progress`/`agent.reply` → `text_delta{stream:"output"}`; final reply also pushes
  `done` + terminal `completed`.
- `agent.done` → `done`+`completed` (or `error`+`failed` if reason is the crash constant).
- `tool.event` Pre/Post → `tool_call{status:"in_progress"|"completed"}`; Stop → nothing.
- `session.ended` → `done`+`completed` (or `error`+`failed` on crash reason).
- `session.started`/`message.sent`/`agent.input_requested` → nothing.

`adapter.ts` (`createClaudeBridgeRuntime({bridge})`): one long-lived `bridge.events()` pump
per session routes translated events to the active turn's async channel; `ensureSession` is
idempotent (no second `claude` per key); `startTurn` sets the active channel BEFORE
`sendMessage`; terminal event resolves `result` and clears the channel; `runTurn` delegates
to `startTurn().events`. Reference adapter for the mapping decisions:
`claude-code-bridge/docs/T3-ClaudeCodeBridgeAdapter.sketch.ts`.

---

## 5. Verified status (re-confirmed 2026-06-05 on host)

| Layer | What | Result |
|------|------|--------|
| L1 | ccb `JsonlEventStore.readAll` Node-compat | ✅ Bun + Node |
| L2 | translator unit tests | ✅ 14 |
| L3 | OpenClaw ACP conformance contract (vendored) | ✅ |
| L4 | adapter ⇄ ccb mock supervisor | ✅ |
| **L5** | adapter ⇄ **real `claude`** (managed launch, Max) | ✅ replied "121" |
| — | node bundle + `node` smoke | ✅ |
| **L6a** | real gateway loads plugin + registers backend | ✅ log: `registered ACP backend "claude-bridge"` |
| L6b | a channel turn dispatches to the backend | ⏳ needs live Telegram (ACP session init via binding) |
| — | full ccb suite | ✅ 354 pass |

**L6b is the only unproven hop and is inherently a live-channel test:** a turn dispatches to
ACP only once `acpManager.resolveSession` is `ready`, which a `type:"acp"` channel **binding**
makes happen when a real message arrives. A one-off `openclaw agent` CLI turn does NOT init a
session, so it falls back to the model lane (we observed an OpenAI 401 — which itself proves
the plugin loaded and the gateway ran).

---

## 6. The ccb Node-compat patch (already applied)

ccb is Bun-only (`engines.bun>=1.3`). The single library-runtime Bun dependency was
`JsonlEventStore.readAll` calling `Bun.file` (`packages/core/src/store.ts`). Patched to use
`node:fs/promises` `readFile` + ENOENT→`[]`. Writes already used `node:fs`. `mcp-channel` /
`claude-code` / `process` packages have zero `Bun.*`. The CLI (`apps/ccb`) still uses
`Bun.write` but the plugin embeds the **library**, not the CLI, so that does not matter.
Result: the library runs under Node (proven by `node dist/smoke.mjs`).

---

## 7. Build, test, and the test layers

```bash
# in claude-code-bridge/ on branch feat/openclaw-acp-bridge
bun install
bun test packages/openclaw-acp                                   # L2,L3,L4
CCB_RUN_REAL_CLAUDE=1 bun test packages/openclaw-acp/src/adapter.real.test.ts  # L5 (needs authed claude)
bun run --cwd packages/openclaw-acp smoke:node                   # L1 node + ships-under-node bundle
bunx tsc -b packages/openclaw-acp/tsconfig.json                  # typecheck
bun run --cwd packages/openclaw-acp build                        # -> packages/openclaw-acp/dist/index.js
bun test                                                         # full suite, no regressions
```

`build` bundles with `bun build --target=node`, inlining `@ccb/*`; externals
`@homebridge/node-pty-prebuilt-multiarch` + `openclaw/*` (host-provided). `openclaw.extensions`
points at `./dist/index.js`.

---

## 8. Deploy from scratch (e.g. a fresh VM)

**You do NOT need to publish to npm.** OpenClaw loads external plugins from a local path via
`plugins.load.paths` (jiti transpiles TS / prefers the built JS next to it).

1. **Claude Code + Max login** — `claude login` with the Max account (needs channels-preview
   eligibility). This binary IS the subscription.
2. **Node 22.19+ and Bun** (Bun only to build the plugin).
3. **Build the plugin:**
   ```bash
   git clone -b feat/openclaw-acp-bridge https://github.com/pablospe/claude-code-bridge
   cd claude-code-bridge && bun install && bun run --cwd packages/openclaw-acp build
   ```
4. **OpenClaw on the host** (not in a sandbox for this agent). Config (`~/.openclaw/openclaw.json`):
   ```jsonc
   {
     "gateway": { "mode": "local" },
     "plugins": {
       "enabled": true,
       "load": { "paths": ["/ABS/PATH/claude-code-bridge/packages/openclaw-acp"] },
       "entries": { "claude-bridge": { "enabled": true } }
     },
     "acp": { "enabled": true, "dispatch": { "enabled": true }, "backend": "claude-bridge" },
     "agents": {
       "defaults": { "sandbox": { "mode": "off" } },
       "list": [{ "id": "main", "default": true, "sandbox": { "mode": "off" },
                  "runtime": { "type": "acp", "acp": { "agent": "main", "backend": "claude-bridge", "mode": "persistent" } } }],
       "bindings": [{ "type": "acp", "agentId": "main",
                      "match": { "channel": "telegram", "accountId": "*" },
                      "acp": { "backend": "claude-bridge", "mode": "persistent" } }]
     }
   }
   ```
   (Same file lives at `packages/openclaw-acp/l6/openclaw.json`.)
5. Start the gateway, connect the channel, **message the bot** — the binding initializes an ACP
   session and routes the turn to `claude-bridge` → interactive `claude` → reply.

**Isolated dry-run without touching a live gateway:** `packages/openclaw-acp/l6/run-l6-smoke.sh`
uses `OPENCLAW_HOME`/`OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` to run a separate gateway. Note:
that script's first run builds the openclaw checkout (heavy; reconciles deps — see §9).

---

## 9. Gotchas already hit (save time)

- **Gateway start needs `gateway.mode:"local"`** and rejects unknown root config keys
  (a `_comment` key fails schema validation: `<root>: Invalid input`).
- **Gateway websocket needs auth** — set `gateway.auth.mode:"token"` + `gateway.auth.token:"..."`
  and pass `--token` to CLI, OR use `openclaw agent --local` (embedded, no websocket). A bare
  generated runtime token is NOT persisted.
- **`openclaw agent` CLI does not initialize an ACP session** → falls back to the model lane.
  Use a real channel + binding to exercise the backend. (`openclaw acp` is the *reverse*
  direction — OpenClaw-as-ACP-server for editors — not a way to invoke this backend.)
- **Building openclaw locally triggers a pnpm deps reconcile** (no `dist/` in a fresh checkout;
  `pnpm openclaw`/`pnpm build` runs `run-node.mjs` → `pnpm install` with a `confirmModulesPurge`
  prompt). Set `CI=true`, or build in an **isolated worktree** to avoid touching a primary
  checkout's `node_modules`. OpenClaw's own AGENTS.md discourages local pnpm builds — prefer
  Crabbox/Testbox for authoritative proof.
- **ACP availability is denied for sandboxed agents** (`openclaw/src/acp/runtime/availability.ts`)
  — the driving agent MUST be `sandbox.mode:"off"`.
- **Tool pre-authorization:** ccb launches `claude` with `--allowed-tools` (no approval relay
  until ccb M5), so the bridged `claude` runs Bash/Edit unattended. Scope the allowed set.
- **node-pty** must resolve where the bundle is loaded (it's external) — keep the ccb repo's
  `node_modules` present (from `bun install`).
- This environment blocked `kill`/`pkill`/`rm -rf` at the permission layer — hand those to the
  user via the `!` prefix if needed.

---

## 10. Open work / future

- **L6b live verification** over Telegram (the binding) — the remaining proof.
- **npm-publishable packaging** so a VM can `openclaw plugins install @pablospe/openclaw-acp-claude-bridge`:
  set `private:false`, replace `workspace:*` deps with the bundled-dist approach (runtime dep =
  just node-pty), add `files:["dist","openclaw.plugin.json"]`, `prepublishOnly` build,
  `openclaw.extensions:["./dist/index.js"]`. Upstream the ccb Node patch + bump ccb.
- **Permission relay** (ccb M5): map `notifications/claude/channel/permission_request` to ACP so
  tools can prompt instead of running pre-authorized.
- **Resume semantics:** ccb's PTY `claude` has no resume cursor; on gateway restart the session
  is gone. Phase 1 starts fresh.
- **Concurrency:** one `claude` PTY per ACP session → multi-agent = multiple parallel `claude`
  on one Max account (possible ToS pressure).
- **Caveat that underpins everything:** legitimacy holds only while it is a genuine *interactive*
  session. If Anthropic reclassifies channel-fed sessions, the premise breaks.

---

## 11. References

- ccb architecture: `claude-code-bridge/docs/ARCHITECTURE.md`; channels:
  https://code.claude.com/docs/en/channels-reference
- Reference adapter (T3 Code): `claude-code-bridge/docs/T3-ClaudeCodeBridgeAdapter.sketch.ts`
- OpenClaw ACP: `openclaw/packages/acp-core/src/runtime/types.ts`,
  `openclaw/src/acp/runtime/{registry,availability}.ts`,
  `openclaw/src/acp/control-plane/manager.*.ts`, `openclaw/extensions/acpx/` (sibling backend
  reference), `openclaw/docs/plugins/manifest.md`.
- This package: spec `docs/2026-06-04-...design.md`, plan `docs/2026-06-05-...plan.md`, `README.md`.
