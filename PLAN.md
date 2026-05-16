# Claude Code Bridge Plan

## Purpose

Claude Code Bridge is a reusable library for controlling interactive Claude Code sessions from external UIs and orchestrators.

The project starts with Claude Code because Claude Code has a unique channel mechanism:

- inbound messages through Claude Code MCP channels
- outbound structured replies through MCP tools
- lifecycle and telemetry through Claude Code hooks
- PTY/tmux only as a process substrate and fallback observation layer

This is not an ACPX replacement and not a universal agent runtime. ACPX already covers ACP-compatible agents and non-interactive adapter flows. This project exists for the different case: using an already authenticated interactive Claude Code session as the runtime while exposing a clean integration surface to other tools.

## Key Decisions

- Language/runtime: TypeScript with Bun as the package manager, test runner, and primary developer runtime.
- Compatibility target: keep the core Node-compatible where practical because MCP SDKs, Claude Code, and consumers may run under Bun, Node, or packaged CLIs.
- Product scope: Claude Code first, not a general multi-agent backend.
- Distribution shape: library first, adapters second.
- Primary protocol shape: bridge-owned event stream, not ACP internally.
- ACP support: optional adapter after the Claude Code loop works.
- Main IO path: Claude Code channels inbound, MCP tools outbound, hooks for lifecycle.
- Fallback IO path: PTY/tmux for process control, raw display, and emergency observation only.

TypeScript is the recommended starting point because this project must implement MCP servers, stream events to web-based UIs, expose WebSocket/HTTP adapters, and integrate naturally with T3 Code-style frontends. Bun is the preferred project toolchain because it gives a fast package manager, test runner, TypeScript execution path, and workspace support with low setup cost. Python may be useful later for small client bindings, but it should not be the core implementation language unless the project changes toward scripting and local automation instead of UI/runtime integration.

The core should avoid unnecessary agent-general abstractions. Other tools such as T3 Code, OpenClaw, agtx, and OpenCode are intended consumers of the bridge. They are not proof that the bridge needs multiple agent backends. ACPX already serves the broader ACP-compatible-agent space.

## Primary Consumers

The library should be designed so these systems can integrate without depending on Claude Code terminal scraping:

- T3 Code-style UIs
- OpenClaw
- agtx
- OpenCode or similar agent UIs
- local custom CLIs and dashboards

These are consumers of the bridge API, not necessarily backends. The first backend is Claude Code only.

## Non-Goals

- Do not build a general replacement for ACPX.
- Do not implement broad multi-agent support before the Claude Code loop works.
- Do not rely on `claude -p` or the Claude Agent SDK for the main runtime path.
- Do not make tmux `send-keys` / `capture-pane` the semantic protocol.
- Do not hide or bypass vendor usage limits. The goal is an alternate interface for interactive Claude Code, not limit evasion.

## Core Architecture

```text
consumer UI/orchestrator
  -> bridge library API
    -> Claude Code session supervisor
      -> Claude Code interactive process
        -> MCP channel server (claude/channel capability + bridge_reply/progress/done tools)
        -> Claude Code hooks (lifecycle/telemetry)
        -> optional PTY/tmux (launch substrate or fallback observation)
```

The bridge library owns session state, event normalization, and integration APIs. Claude Code remains the agent runtime.

## Directional Communication

Inbound to Claude Code (bridge -> Claude):

```text
consumer
  -> bridge.sendMessage(sessionId, content)
  -> channel server emits notifications/claude/channel
  -> Claude Code surfaces <channel source="ccb" session_id="..." message_id="...">content</channel>
```

The channel server declares `capabilities.experimental['claude/channel'] = {}`. Channels are a Claude Code research-preview feature ([reference](https://code.claude.com/docs/en/channels-reference)) and require launching with `--dangerously-load-development-channels server:ccb` until the channel is on the approved allowlist.

Outbound from Claude Code (Claude -> bridge):

```text
Claude Code
  -> MCP tool call: bridge_reply / bridge_progress / bridge_done
  -> channel server forwards over per-session local control connection
  -> bridge appends to JSONL event log
  -> consumer event stream
```

- `bridge_reply({ content, final })` — response payload; `final:true` marks the answer complete.
- `bridge_progress({ content })` — intermediate progress before a final reply.
- `bridge_done({ reason? })` — end of turn; bridge tears down the session when configured.

The channel server's `instructions` field (added to Claude's system prompt) tells Claude when to call each tool.

Observation and backup:

```text
Claude Code hooks
  -> session/tool/stop events
  -> bridge event log

PTY/tmux capture
  -> raw terminal view or emergency fallback only
```

## Process Topology

For real Claude Code sessions, Claude Code spawns each MCP server as its own stdio subprocess, so the channel server cannot be embedded in the bridge process. The managed real-session topology is three processes:

```text
ccb (bridge library + CLI)
  │
  └─ spawn: claude --dangerously-load-development-channels server:ccb
        │
        └─ spawn: ccb channel server (stdio child of claude)
              │
              └─ local control connection back to bridge
```

In manual smoke-test mode, the user may start `claude` instead of having `ccb` spawn it. The process tree changes, but the bridge, Claude Code, and the channel server still communicate the same way.

The bridge and the channel server are siblings under different parents in managed mode. They share a per-session local control connection carrying a JSON-lines control protocol:

- bridge -> channel server: `{ type: "deliver", content, messageId, meta }` -> server emits `notifications/claude/channel`.
- channel server -> bridge: `{ type: "tool", name, args }` -> bridge appends the event and fans out to consumers.

The bridge provides `CCB_BRIDGE_ENDPOINT` and `CCB_SESSION_ID` to the Claude Code environment; the channel server reads them at startup.

Control transport choice:

- Milestone 1: use loopback TCP on `127.0.0.1` for the bridge <-> channel-server control connection. This gives the same code path on Windows, macOS, Linux, and WSL.
- Later Unix/macOS/Linux/WSL optimization: Unix domain socket under `$XDG_RUNTIME_DIR` or the OS temp directory.
- Later Windows optimization: named pipe.
- Tests: in-process mock transport.

Do not hard-code Unix sockets or named pipes into the core API.

For tests and mock sessions, the channel server and control transport may run in-process. That shortcut is only for tests; the real Claude Code integration must exercise the stdio MCP server path that Claude Code actually launches.

## Library Surface

The first public API should be small and stable:

```ts
type BridgeEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.sent"; sessionId: string; messageId: string; content: string }
  | { type: "agent.progress"; sessionId: string; messageId?: string; content: string }
  | { type: "agent.reply"; sessionId: string; messageId?: string; content: string; final: boolean }
  | { type: "agent.input_requested"; sessionId: string; requestId: string; prompt: string }
  | { type: "tool.event"; sessionId: string; payload: unknown }
  | { type: "session.ended"; sessionId: string; reason?: string };

interface ClaudeCodeBridge {
  startSession(options: StartSessionOptions): Promise<SessionHandle>;
  sendMessage(sessionId: string, content: string, options?: SendOptions): Promise<string>;
  events(sessionId: string): AsyncIterable<BridgeEvent>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
```

`events(sessionId)` is a live tail from subscribe-time forward in milestone 1. The options type reserves a `since` field for later replay-from-cursor support backed by the JSONL store.

The API should be library-first. A local daemon, CLI, HTTP server, WebSocket server, and ACP facade can be built as adapters on top.

## Repository Bootstrap

Use Bun, but do not start from a large external template. Most available Bun templates are full-stack web apps, while this repository is a library plus CLI plus MCP server. Bun's official `bun create` can scaffold from GitHub, npm `create-*` packages, React components, or local templates, but no currently identified template matches this project closely enough to justify importing its structure.

Recommended bootstrap:

```bash
cd ~/code/claude-code-bridge
bun init -y
```

Then add Bun workspaces manually:

```json
{
  "name": "claude-code-bridge",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc -b",
    "lint": "bunx biome check .",
    "format": "bunx biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "latest",
    "typescript": "latest"
  }
}
```

If a template is later used, prefer a minimal Bun TypeScript library/workspace template only. Avoid full-stack templates that add React, Hono, databases, Docker, Tailwind, or deployment assumptions before the bridge loop is working.

## Package Layout

Initial TypeScript monorepo:

```text
packages/core
  session model, event types, event store, public API contracts

packages/claude-code
  Claude Code process supervision, config generation, hook wiring

packages/mcp-channel
  MCP channel server and outbound reply/progress tools

packages/process
  Optional in milestone 1. Houses managed process launch, interrupt, raw
  observation, and fallback helpers. Use node-pty only if a managed real
  Claude Code smoke test requires a TTY to keep the interactive session alive.
  The pty is a launch substrate, not the protocol path — inbound stays on
  notifications/claude/channel and outbound stays on MCP tools. PTY output is
  discarded by default and optionally tee'd to a debug log. node-pty is the
  preferred cross-platform backend; tmux is optional and Unix/WSL-only.

packages/http
  optional REST/WebSocket adapter for UIs like T3 Code

packages/acp
  optional ACP-compatible facade for OpenClaw-style integrations

apps/ccb
  developer CLI for testing sessions locally
```

## First Milestone

Prove the smallest useful end-to-end loop:

```text
test CLI sends message
  -> bridge library manages or registers a Claude Code session
  -> Claude Code receives message through channel
  -> Claude Code calls MCP reply tool
  -> bridge records event
  -> test CLI prints reply
```

Success criteria:

- no `claude -p`
- no Agent SDK dependency
- inbound messages delivered as `notifications/claude/channel`
- outbound semantic events delivered as MCP tool calls (`bridge_reply` / `bridge_progress` / `bridge_done`)
- no PTY/tmux on the protocol path
- session events persisted as append-only JSONL
- consumer can subscribe to events while the turn is running
- `MockSupervisor` covers unit and CI tests
- a real Claude Code smoke test proves the stdio MCP channel server path
- PTY/node-pty is not the semantic protocol. Manual smoke inherits its TTY from the user's terminal; managed launch wraps `claude` in node-pty to satisfy its boot-time TTY check (verified empirically: `claude` exits to --print when stdout is not a TTY). The PTY must not carry reply/progress data in either case.

Milestone 1 has two implementation tracks:

```text
Automated track:
  MockSupervisor + in-process/mock transport
  verifies event model, JSONL store, MCP tool handlers, CLI event streaming

Real smoke track:
  real Claude Code session + real stdio MCP channel server
  verifies notifications/claude/channel and bridge_reply/progress/done
```

The real smoke track may start as a manual setup documented in README:

```text
1. start the bridge control server
2. start Claude Code with the ccb MCP server configured and
   --dangerously-load-development-channels server:ccb
3. run ccb send/watch from another terminal
```

After the smoke path works manually, add managed launch. Managed launch wraps `claude` in node-pty to provide the TTY it requires (verified empirically: `claude` exits to --print when stdout is not a TTY). The PTY is a process-hosting detail, not a change to the semantic channel-in/MCP-out design.

## Integration Strategy

T3 Code-style UI:

- Use the HTTP/WebSocket adapter.
- Render bridge events as chat/progress/tool timeline.
- Keep UI independent from Claude Code terminal format.

OpenClaw:

- Prefer an ACP facade once the core loop is proven.
- Map ACP session/prompt/update semantics onto bridge sessions and events.

agtx:

- Use the library or HTTP adapter as a task-session backend.
- Convert bridge events into durable task comments/progress.
- Use channels instead of tmux `send-keys` when Claude Code is the runtime.

OpenCode:

- Treat as a consumer UI first.
- Do not add an OpenCode backend unless there is a concrete gap ACPX does not solve.

## Open Questions

1. Should the first implementation attach to an existing Claude Code session or launch a managed one?

Recommended answer: support a manual real-session smoke test first, then add managed launch. Do not attach to arbitrary pre-existing sessions in milestone 1; that creates discovery and state ambiguity too early.

2. Should the bridge store events in JSONL, SQLite, or both?

Recommended answer: JSONL first. Add SQLite when querying/indexing becomes necessary.

3. Should the MCP channel server be embedded in the library process or launched as a child process?

Decided: it cannot be embedded in the main bridge process for real Claude Code sessions. Claude Code spawns channel servers as its own stdio subprocesses, so the topology is three processes — bridge, claude, channel server — and the bridge talks to the channel server over a per-session local control connection. See [Process Topology](#process-topology).

4. Should ACP be implemented in milestone 1?

Recommended answer: no. Build ACP after the channel/reply loop works.

5. Should the package expose only TypeScript APIs?

Recommended answer: start with TypeScript APIs, then add a local HTTP/WebSocket adapter so non-Node consumers can integrate.

## Immediate Next Steps

1. Initialize Bun workspaces per the Repository Bootstrap section.
2. Define `BridgeEvent` and session API in `packages/core`.
3. Build a minimal MCP channel server with reply/progress tools.
4. Build a CLI that can start the bridge control server, send a channel message, and watch the event stream.
5. Document and verify the manual real Claude Code smoke test without terminal scraping.
6. Add managed Claude Code launch (node-pty TTY surrogate for `claude`'s boot-time TTY check) after the manual smoke path works.
