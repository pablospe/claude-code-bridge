# Claude Channel Bridge Plan

## Purpose

Claude Channel Bridge is a reusable library for controlling interactive Claude Code sessions from external UIs and orchestrators.

The project starts with Claude Code because Claude Code has a unique channel mechanism:

- inbound messages through Claude Code MCP channels
- outbound structured replies through MCP tools
- lifecycle and telemetry through Claude Code hooks
- PTY/tmux only as a process substrate and fallback observation layer

This is not an ACPX replacement and not a universal agent runtime. ACPX already covers ACP-compatible agents and non-interactive adapter flows. This project exists for the different case: using an already authenticated interactive Claude Code session as the runtime while exposing a clean integration surface to other tools.

## Key Decisions

- Language/runtime: TypeScript on Node.js.
- Product scope: Claude Code first, not a general multi-agent backend.
- Distribution shape: library first, adapters second.
- Primary protocol shape: bridge-owned event stream, not ACP internally.
- ACP support: optional adapter after the Claude Code loop works.
- Main IO path: Claude Code channels inbound, MCP tools outbound, hooks for lifecycle.
- Fallback IO path: PTY/tmux for process control, raw display, and emergency observation only.

TypeScript is the recommended starting point because this project must implement MCP servers, stream events to web-based UIs, expose WebSocket/HTTP adapters, and integrate naturally with T3 Code-style frontends. Python may be useful later for small client bindings, but it should not be the core implementation language unless the project changes toward scripting and local automation instead of UI/runtime integration.

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
        -> MCP channel server
        -> MCP reply/progress tools
        -> Claude Code hooks
        -> optional PTY/tmux fallback
```

The bridge library owns session state, event normalization, and integration APIs. Claude Code remains the agent runtime.

## Directional Communication

Inbound to Claude Code:

```text
consumer
  -> bridge.sendMessage(...)
  -> MCP channel notification
  -> Claude Code receives <channel ...> content
```

Outbound from Claude Code:

```text
Claude Code
  -> MCP tool call: reply/progress/request_input/done
  -> bridge event log
  -> consumer event stream
```

Observation and backup:

```text
Claude Code hooks
  -> session/tool/stop events
  -> bridge event log

PTY/tmux capture
  -> raw terminal view or emergency fallback only
```

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

interface ClaudeChannelBridge {
  startSession(options: StartSessionOptions): Promise<SessionHandle>;
  sendMessage(sessionId: string, content: string, options?: SendOptions): Promise<string>;
  events(sessionId: string): AsyncIterable<BridgeEvent>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
```

The API should be library-first. A local daemon, CLI, HTTP server, WebSocket server, and ACP facade can be built as adapters on top.

## Package Layout

Initial TypeScript monorepo:

```text
packages/core
  session model, event types, event store, public API contracts

packages/claude-code
  Claude Code process supervision, config generation, hook wiring

packages/mcp-channel
  MCP channel server and outbound reply/progress tools

packages/node-pty
  PTY/tmux helpers for launch, interrupt, raw observation, fallback

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
  -> bridge library starts or attaches to Claude Code
  -> Claude Code receives message through channel
  -> Claude Code calls MCP reply tool
  -> bridge records event
  -> test CLI prints reply
```

Success criteria:

- no `claude -p`
- no Agent SDK dependency
- no terminal scraping for the main reply path
- session events are persisted as append-only JSONL
- consumer can subscribe to events while the turn is running

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

Recommended answer: launch a managed one first. Attaching to arbitrary existing sessions creates discovery and state ambiguity too early.

2. Should the bridge store events in JSONL, SQLite, or both?

Recommended answer: JSONL first. Add SQLite when querying/indexing becomes necessary.

3. Should the MCP channel server be embedded in the library process or launched as a child process?

Recommended answer: embedded first for simpler lifecycle and event routing.

4. Should ACP be implemented in milestone 1?

Recommended answer: no. Build ACP after the channel/reply loop works.

5. Should the package expose only TypeScript APIs?

Recommended answer: start with TypeScript APIs, then add a local HTTP/WebSocket adapter so non-Node consumers can integrate.

## Immediate Next Steps

1. Initialize a TypeScript monorepo.
2. Define `BridgeEvent` and session API in `packages/core`.
3. Build a minimal MCP channel server with reply/progress tools.
4. Build a CLI that can start a managed Claude Code process with that MCP server configured.
5. Verify a full send/reply event loop without terminal scraping.
