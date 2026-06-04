# @pablospe/openclaw-acp-claude-bridge

OpenClaw ACP runtime backend that powers an OpenClaw agent with a **genuine
interactive Claude Code session** (your Pro/Max subscription) via
[claude-code-bridge](https://github.com/pablospe/claude-code-bridge).

## Why

Anthropic now reserves the interactive subscription allowance for *interactive*
Claude Code; headless (`claude -p`) and Agent-SDK usage bill against a separate,
capped credit, and replaying the OAuth token from a non-genuine client is
disallowed. The only way to spend the interactive allowance from automation is
to drive a **real interactive `claude` session** — which is exactly what ccb
does (channels in, MCP tools out). This plugin lets OpenClaw be that driver while
keeping its own session/turn/channel-routing machinery. Claude Code is the
reasoner; OpenClaw is the conductor.

## How it works

```
OpenClaw gateway ──ACP──▶ this plugin (backend id "claude-bridge")
                              │ embeds ccb Bridge + ClaudeCodeSupervisor
                              ▼ node-pty
                       genuine interactive `claude` (Max login) ── reasons
```

- `ensureSession` → `bridge.startSession()` (ccb spawns/supervises `claude`).
- `startTurn` → `bridge.sendMessage()`; ccb `agent.progress`/`agent.reply`/
  `agent.done` + `tool.event` are translated to ACP `text_delta`/`done`/
  `tool_call`/`error` (`src/translator.ts`).
- One long-lived `bridge.events()` pump per session; one `claude` PTY per session.
- No tmux: the bridge's `ClaudeCodeSupervisor` launches and supervises `claude`.

## Status (verified on host 2026-06-05)

| Layer | What | Result |
|-------|------|--------|
| L1 | ccb `JsonlEventStore.readAll` Node-compat patch | ✅ Bun + Node |
| L2 | `BridgeEvent → AcpRuntimeEvent` translator | ✅ 14 unit tests |
| L3 | passes OpenClaw's `runAcpRuntimeAdapterContract` (vendored) | ✅ |
| L4 | adapter ⇄ ccb mock supervisor end-to-end | ✅ |
| L5 | adapter ⇄ **real `claude`** (managed launch, Max login) | ✅ replied "121" |
| —  | Node bundle + `node` smoke (ships under Node) | ✅ |
| L6 | OpenClaw gateway loads plugin + routes a turn | ⏳ turnkey (`l6/`) |

Run the suite:

```bash
bun test packages/openclaw-acp                                  # L2–L4
CCB_RUN_REAL_CLAUDE=1 bun test packages/openclaw-acp/src/adapter.real.test.ts  # L5
bun run --cwd packages/openclaw-acp smoke:node                  # L1 node + bundle
```

## L6 — load into an OpenClaw gateway

`src/index.ts` is the OpenClaw plugin entry (registers backend `claude-bridge`).
`openclaw.plugin.json` is the manifest. To prove it against a **real, isolated**
gateway without touching a live one, see `l6/run-l6-smoke.sh` and `l6/openclaw.json`.
The one heavy/gated prerequisite is building the openclaw checkout
(`cd ~/code/openclaw && CI=true pnpm build`) — left to you because it reconciles
deps on your primary checkout.

Production wiring is config-only on the OpenClaw side: point `plugins.load.paths`
at this package, set `acp.backend: "claude-bridge"`, and run the driving agent
**non-sandboxed** (OpenClaw denies ACP for sandboxed agents).
