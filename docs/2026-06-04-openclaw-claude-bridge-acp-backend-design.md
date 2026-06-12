# Design: Drive OpenClaw with a Claude Max subscription via a ccb-backed ACP runtime backend

**Date:** 2026-06-04
**Status:** Design — awaiting review
**Author:** Pablo Speciale

**Resolved decisions:** (1) Claude Code is the reasoner; OpenClaw keeps session/turn/routing.
(2) New custom ACP backend — no ACP-core changes, acpx untouched. (3) ccb embedded as a
**Node** library after a small Node-compat patch (see Runtime). (4) Ships as an
**OpenClaw external plugin co-located in the `claude-code-bridge` repo** (new workspace
package under `plugins/`), installed into OpenClaw — OpenClaw is touched by *config only*,
no code. (5) Gateway runs on the host; `claude` spawned alongside under the host Max login;
driving agent non-sandboxed.

## Problem

OpenClaw currently needs a paid Anthropic API key (or a per-token billing path) to
run. The goal is to power OpenClaw with an existing **Claude Max subscription** instead.

The two obvious ways to reuse a Max subscription are both dead ends for this goal:

1. **OAuth token replay** — lifting the `sk-ant-oat` token and calling Anthropic's API
   from a non-genuine client (what `src/llm/providers/anthropic.ts:887` does with spoofed
   `claude-cli` headers). Disallowed; gets accounts flagged.
2. **`claude -p` / Agent SDK headless** — still the genuine binary, but effective
   **2026-06-15** headless/SDK usage stops drawing from the interactive subscription
   allowance and bills against a separate, capped monthly "Agent SDK credit." The
   interactive subscription quota is reserved for *interactive* usage only (terminal
   Claude Code, Cowork, chat).

## Core thesis (the whole design rests on this)

The **only** way to spend the interactive Max allowance from automation is to feed a
**genuine, persistent, interactive Claude Code session**. `claude-code-bridge` (ccb) does
exactly this: it pushes messages into a running interactive `claude` over Anthropic's
**channels** MCP surface and reads structured replies back via three MCP tools — no token
replay, no headless/SDK reclassification. From Anthropic's side it is indistinguishable
from a human using Claude Code.

**Consequence:** Claude Code is the reasoner. OpenClaw cannot be the "brain" on Max quota —
the interactive session is a full agent, not a raw model endpoint. What OpenClaw *keeps* is
its session/turn/channel-routing/multi-agent machinery; it delegates the "produce this
turn's answer" step to ccb.

## Goals

- Power an OpenClaw agent's turns with an interactive Claude Code session under a Max login.
- Preserve OpenClaw's native session persistence, channel routing (Telegram/Discord/etc.),
  turn lifecycle, and terminal-outcome handling — **no second routing layer**.
- **Zero changes to the OpenClaw repo**: no ACP-core (`packages/acp-core`) edits, no `acpx`
  edits, no bundled `extensions/` addition. The integration is an external installed plugin;
  OpenClaw is configured, not modified.
- Eliminate the manual tmux babysitter: the plugin launches and supervises `claude` itself.

## Non-goals

- OpenClaw acting as the reasoning agent (impossible on Max quota — see thesis).
- Token-level streaming (ccb is message-level; OpenClaw forbids token-delta channel
  messages anyway).
- Tool-approval prompt routing (ccb M5, unshipped) — phase 1 pre-authorizes tools.
- Free-text elicitation / AskUserQuestion relay (ccb reserves `agent.input_requested`).

## Why this is feasible (contract evidence)

OpenClaw's ACP runtime contract is transport-agnostic. A backend is registered with a
3-field object and need not spawn a subprocess:

- `src/acp/runtime/registry.ts:8` — `AcpRuntimeBackend = { id, runtime, healthy? }`.
- `packages/acp-core/src/runtime/types.ts:161` — `AcpRuntime` requires `ensureSession`,
  `runTurn`, `cancel`, `close`; optional `startTurn` (preferred), `getCapabilities`,
  `getStatus`, `doctor`, `prepareFreshSession`. The session handle
  (`types.ts:21`) is an opaque bag of strings — **no PID/process handle anywhere.**
- All PID-lease / process-reaping machinery is **internal to the acpx plugin**
  (`extensions/acpx/src/`), not the core contract (`docs/refactor/acp.md` is explicitly
  acpx-scoped). A non-spawning backend simply opts out of it.
- ACP-backed sessions still flow through OpenClaw's normal machinery:
  `src/plugin-sdk/acp-runtime-backend.ts:53` routes channel turns through the manager "so
  session state, tool calls, and memory stay consistent." Persistence is manager-owned via
  the `acp_sessions` table (`src/state/openclaw-state-schema.generated.ts:532`), not the
  backend.
- Availability gate `src/acp/runtime/availability.ts:7` denies ACP when **sandboxed** and
  resolves the backend by `config.acp.backend`. A backend declares availability by being
  registered (+ optional `healthy()`).

ccb's library surface confirms the spawn/supervise capability:

- `ARCHITECTURE.md:218` — `ClaudeCodeSupervisor` spawns `claude` via `node-pty`; managed
  launch works end-to-end on Bun-on-Linux (`ARCHITECTURE.md:236`).
- `docs/T3-ClaudeCodeBridgeAdapter.sketch.ts` — a complete, commented adapter for T3 Code's
  provider contract. Our work is the same translation retargeted to `AcpRuntime`.

## Architecture

```
Telegram / Discord ──► OpenClaw gateway (on host, NOT Docker for this agent)
                          │   channel routing · session · turn lifecycle  (UNCHANGED)
                          ▼
                   ACP manager.runTurn        config.acp.backend = "claude-bridge"
                          ▼
        ┌──────────────────────────────────────────────────┐
        │  NEW external plugin (own repo, installed via      │  implements AcpRuntime
        │  plugins.allow): registers backend "claude-bridge" │  (no process mgmt of its own)
        │  embeds @pablospe/claude-code-bridge `Bridge`      │  via SDK seam
        │  (Node-patched) — supervisorFactory:               │  acp-runtime-backend
        │  claudeCodeSupervisorFactory → ccb spawns claude   │
        └──────────────────────────────────────────────────┘
                          │  in-process library calls (sendMessage / events)
                          ▼
                  ccb Bridge + ClaudeCodeSupervisor
                          │  channels (inbound)  ·  bridge_reply/_progress/_done (outbound)
                          ▼
        GENUINE interactive `claude` (host Max login)  ◄── does the reasoning
```

### Deployment decision (resolved)

For this setup the **OpenClaw gateway runs directly on the host** (not in the Podman/Docker
container). Rationale: the plugin spawns `claude` via `node-pty` and that process must (a)
use the host's existing Max login (`~/.claude`), and (b) share `localhost` with the bridge's
loopback control server, since ccb's channel server dials back over loopback TCP
(`ARCHITECTURE.md:89`). Running the gateway on the host gives both for free. The ACP-driving
agent must be **non-sandboxed** so `availability.ts:7` does not deny ACP.

This is a per-setup operational choice; the containerized gateway remains available for
other (API-key-backed) agents.

## Components

### 1. NEW — OpenClaw plugin `@pablospe/openclaw-acp-claude-bridge` (in the ccb repo)

A new workspace package under `plugins/openclaw-acp/` in the `claude-code-bridge` repo
(sibling to the existing Claude-Code-side `plugins/ccb`). It is an **external installed
OpenClaw plugin** (not bundled in `extensions/`, not in core dist), per OpenClaw's rule that
optional integrations route to plugins. It mirrors acpx's registration *pattern*
(`extensions/acpx/register.runtime.ts:65` as reference): a plugin service whose `start(ctx)`
calls `registerAcpRuntimeBackend({ id: "claude-bridge", runtime })` and whose `stop` calls
`unregisterAcpRuntimeBackend`. Imports come only from the public SDK seam
`openclaw/plugin-sdk/acp-runtime-backend` (`src/plugin-sdk/acp-runtime-backend.ts:10`) — so
nothing in the OpenClaw repo changes. Depends on the local `@pablospe/claude-code-bridge`
library. Must build a **Node-targeted** dist (OpenClaw runs on Node) even though the repo's
tooling is Bun. Installed and enabled via `plugins.allow`.

The `runtime` is a single `Bridge` instance constructed with the managed-launch supervisor:

```ts
new Bridge({
  storeDir,                       // ccb JSONL store dir (plugin-local)
  supervisorFactory: claudeCodeSupervisorFactory({
    channels: "dev-flag",
    hooks: { events: ["PreToolUse", "PostToolUse", "Stop"] },
  }),
})
```

It implements `AcpRuntime`:

| `AcpRuntime` method | ccb call | notes |
|---|---|---|
| `ensureSession(handle, opts)` | `bridge.startSession({})` → start `bridge.events(id)` consumer | map `runtimeSessionName` ↔ ccb session id; honor `resumeSessionId` to re-attach |
| `startTurn({ text })` | `bridge.sendMessage(id, text)` | returns `{ events, result, cancel, closeStream }`; events fed from translator |
| `cancel(handle)` | `bridge.interrupt(id)` | best-effort (PTY claude can't always be cleanly preempted) |
| `close(handle, { discardPersistentState? })` | `bridge.close(id)` | if discarding, mark fresh so next `ensureSession` starts a new claude |
| `healthy()` | bridge/supervisor liveness | gates auto-select and availability |
| `doctor()` | claude reachable? channels handshake ok? | renders in `/acp` diagnostics |

Prefer `startTurn` (split events + result) over `runTurn` for clean terminal reporting
(`src/acp/control-plane/manager.turn-stream.ts:119`). Validate against the conformance
harness `src/acp/runtime/adapter-contract.testkit.ts`.

### 2. ccb `Bridge` library — embedded, after a Node-compat patch

`@pablospe/claude-code-bridge` (currently 0.1.0). Public API used: `startSession`,
`sendMessage`, `events`, `interrupt`, `close`, `readStoredEvents`. `ClaudeCodeSupervisor`
owns the `node-pty` `claude` process. No separate `ccb serve`, no tmux.

**Required ccb change (owner repo, separate branch/worktree):** ccb is Bun-only today
(`engines.bun >= 1.3`, no `node`). The *only* library-runtime Bun dependency is
`JsonlEventStore.readAll()` at `packages/core/src/store.ts:37-41` (`Bun.file(...).exists()/.text()`);
writes already use `node:fs` (`store.ts:1`), and `mcp-channel` / `claude-code` / `process`
packages have zero `Bun.*` (the PTY launcher uses `node:fs` + the node-pty polyfill). The
patch: replace that one `Bun.file` read with `node:fs/promises` `readFile` + ENOENT catch,
add `engines.node`, and confirm `bun build` still bundles a Node-clean `dist/`. The
remaining `Bun.write` calls live in the CLI (`apps/ccb`), which the plugin does not use
(it embeds the library, not the `ccb` bin). Net: ~10 lines, makes ccb genuinely
dual-runtime, embeddable in OpenClaw's Node process with no boundary.

### 3. Interactive `claude` — host Max login, unchanged

Launched/supervised by ccb with `--dangerously-load-development-channels` and the generated
per-session MCP config. Pre-authorized tools via `--allowed-tools` (phase 1).

## Turn flow & event translation

Port the proven mapping from `T3-ClaudeCodeBridgeAdapter.sketch.ts:140-279`, retargeted to
`AcpRuntimeEvent` (`packages/acp-core/src/runtime/types.ts:94`):

1. `startTurn({text})` → emit ACP nothing special; call `bridge.sendMessage(id, text)`.
2. ccb `agent.progress` / `agent.reply` → ACP `text_delta { stream: "output", delta }`
   (message-level chunk, not token-level).
3. Turn terminates on **either** ccb `agent.reply{ final:true }` **or** `agent.done`
   (`ARCHITECTURE.md:281`) → emit ACP `done(stopReason)` + resolve `result:{ status:"completed" }`.
   Gate so the second signal does not double-close (sketch `:151-184`).
4. ccb `tool.event` (PreToolUse/PostToolUse hook relay) → ACP `tool_call { status }`
   (observational; correlate Pre/Post by tool name within a turn, sketch `:212-256`).
5. ccb `session.ended` / synthesized crash `agent.done(reason)` → ACP `error`/`done` + `result`.
6. `agent.input_requested` — not minted by ccb today; leave a non-emitting case for
   exhaustiveness (future elicitation relay).

OpenClaw's manager maps the `result` into the normalized terminal outcome and writes
agent-run/task state (`manager.turn-stream.ts:84`, `manager.turn-runner.ts`). We inherit
session persistence, channel routing, and terminal-outcome handling unchanged.

## Repositories & work isolation

All new code lands in **one repo**: `~/code/claude-code-bridge` (owned), on a feature
branch/worktree:

- `packages/core` — the Node-compat patch (the one `Bun.file` in `readAll`).
- `plugins/openclaw-acp/` — NEW workspace package, the OpenClaw plugin + ACP adapter.
- `plugins/ccb/` — existing Claude-Code-side plugin, unchanged.
- Cut a new `@pablospe/claude-code-bridge` version once patched + the plugin published.

**`~/code/openclaw`** is **untouched as code** — only runtime config (below). This design
doc should move into `claude-code-bridge/docs/` (it currently lives in the openclaw
checkout for convenience).

## Configuration (OpenClaw side — config only, no code)

- `config.acp.backend = "claude-bridge"` (default is `acpx`; must be set or default
  resolution returns acpx — `availability.ts:18`, `diagnostics.ts:51`). Verify
  `src/config/types.acp.ts` accepts arbitrary backend ids; if it enum-restricts them, that
  is the one place a tiny additive OpenClaw change might be needed — confirm during planning.
- Plugin allowlist: `plugins.allow` must include the plugin (or be unset) —
  `diagnostics.ts:77`.
- The target agent must be **non-sandboxed**.
- ccb knobs surfaced via plugin config: `storeDir`, `--allowed-tools` set,
  `CCB_CHANNEL_READY_SETTLE_MS` (default 500ms).

## Caveats / risks

1. **Pre-authorized tool execution.** `claude` runs Bash/Edit/Write unattended under
   `--allowed-tools` (no approval relay until ccb M5). It executes on the host with the
   user's privileges. Scope the allowed-tool set deliberately; this is a security boundary.
2. **`cancel` is best-effort.** A PTY-driven interactive turn can't always be preempted;
   the contract permits `cancel → Promise<void>`, but cancel UX is weaker than acpx.
3. **Concurrency = one `claude` PTY per ACP session.** Multi-agent / multi-channel implies
   multiple parallel interactive `claude` processes on one Max account — itself a possible
   quota/ToS pressure point. Phase 1: limit to a single bridge-backed agent.
4. **Research-preview fragility.** Rides `--dangerously-load-development-channels`; the
   500ms channel-ready settle is a timing margin, not a handshake (`ARCHITECTURE.md:256`).
   A Claude Code upgrade can break it. Pin/track a known-good `claude` version.
5. **Quota legitimacy is the load-bearing assumption.** Only holds while it is a genuine
   interactive session. If Anthropic later reclassifies channel-fed sessions, the premise
   breaks.

## Testing

- Unit: adapter translation table against `mockSupervisorFactory()` (no real claude),
  asserting BridgeEvent → AcpRuntimeEvent for each case incl. the dual terminal signal.
- Conformance: run the backend through `src/acp/runtime/adapter-contract.testkit.ts`.
- Integration (manual / Crabbox-style, on host): real Max login, send a Telegram message to
  a `claude-bridge`-backed agent, observe a round-tripped reply; verify `acp_sessions` row,
  turn persistence, and `/acp` doctor output.

## Open questions

- Does `src/config/types.acp.ts` accept a non-`acpx` backend id without schema changes?
  (Verify; if enum-restricted, an additive OpenClaw change is the sole possible code touch.)
- Resume semantics: on gateway restart, ccb's PTY `claude` is gone (no SDK resume cursor —
  sketch `:24`). Define behavior: start fresh vs. replay first N turns via `sendMessage`.
  Phase 1: start fresh, accept context loss on restart.

*Resolved:* runtime gap (ccb Node-compat patch — see Component 2); plugin home (external
repo); deployment (gateway on host).

## References

- ccb: `~/code/claude-code-bridge` — `docs/ARCHITECTURE.md`, `src/index.ts` (public API),
  `docs/T3-ClaudeCodeBridgeAdapter.sketch.ts` (reference adapter).
- OpenClaw ACP: `packages/acp-core/src/runtime/types.ts`, `src/acp/runtime/registry.ts`,
  `src/acp/runtime/availability.ts`, `src/acp/control-plane/manager.turn-stream.ts`,
  `src/plugin-sdk/acp-runtime-backend.ts`, `extensions/acpx/register.runtime.ts`,
  `docs/refactor/acp.md`.
