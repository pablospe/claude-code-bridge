# Architecture

## The idea

Channels for one direction, MCP tools for the other. Together they let an external consumer drive
a running, already-authenticated Claude Code session without restarting it, without scraping the
terminal, and without talking to the model API directly. The bridge owns session state and an
append-only event log; Claude Code remains the agent runtime; the two communicate over a thin
per-session control connection between the bridge and a stdio MCP server that Claude Code spawns
as its own child.

## The diagram

```text
                  inbound: channels (one direction)
                  ─────────────────────────────────▶

  ┌───────────────┐    sendMessage()    ┌───────────────────────────────────┐
  │  Consumer     │ ──────────────────▶ │  Bridge process                   │
  │  (ccb demo,   │                     │  ┌──────────────────────────────┐ │
  │   T3 Code,    │ ◀────────────────── │  │ EventBus + JsonlEventStore   │ │
  │   agtx, ...)  │  events(sessionId)  │  │ Supervisor (Mock | Serve |   │ │
  └───────────────┘                     │  │  ClaudeCode)                 │ │
                                        │  │ ControlServer (loopback TCP) │ │
                                        │  └──────────────┬───────────────┘ │
                                        └─────────────────┼─────────────────┘
                                                          │ JSON-lines
                                                          │ deliver / tool
                                                          ▼
  ┌─────────────────────────────┐        spawn       ┌──────────────────────┐
  │ Claude Code process         │ ─────────────────▶ │ Channel server       │
  │ (claude --channels ...)     │  stdio MCP child   │ (ccb-channel-server) │
  │                             │ ◀───────────────── │  ControlClient       │
  │ notifications/claude/channel│  MCP notification  │  MCP tool handlers   │
  │ <channel source="ccb" ...>  │ ─────────────────▶ │  bridge_reply/       │
  │ bridge_reply / _progress /  │  MCP tool call     │  _progress / _done   │
  │ _done                       │                    │                      │
  └─────────────────────────────┘                    └──────────────────────┘

                  ◀─────────────────────────────────
                  outbound: MCP tools (other direction)
```

## Process topology

Three processes are involved in a real session. The bridge process is the long-lived host: it
owns the `EventBus`, the JSONL store, the `Supervisor` instance, and the loopback
`ControlServer` that listens on `127.0.0.1:<port>`. The `claude` process is launched separately
(by the user in manual smoke, by the supervisor in managed launch) with `--mcp-config` pointing
at a per-session JSON document that names `ccb-channel-server` as an MCP server. Claude Code
spawns that channel server as its own stdio subprocess, hands it the bridge endpoint via
`CCB_BRIDGE_ENDPOINT` and the wire session id via `CCB_SESSION_ID`, and the channel server
dials back to the bridge over loopback TCP. From that point onward, the bridge and the channel
server are siblings under different parents, glued together by one per-session JSON-lines
control connection.

This split is forced by Claude Code's MCP model: MCP servers are stdio children of `claude`,
not of the consumer. So the channel server cannot be embedded in the bridge process and the
control connection is the only place the two sides meet. See `PLAN.md` for the envelope
spec (`hello`, `hello_ack`, `deliver`, `tool`, `close`) and the rationale for loopback TCP over
Unix sockets and named pipes.

## How a turn flows

1. Consumer calls `bridge.sendMessage(sessionId, "hello")`.
2. The bridge mints a `messageId`, emits `message.sent`, persists it to
   `.ccb-data/<bridge-uuid>.jsonl`, and forwards the content to its `Supervisor`.
3. The supervisor (typically `ServeSupervisor` for `ccb serve` or `ClaudeCodeSupervisor` for
   managed launch) asks its `ControlServer` to deliver the message to the session's socket.
4. The `ControlServer` writes a single JSON line — `{"type":"deliver","content":"hello",...}` —
   over the loopback TCP control connection to the `ControlClient` running inside the channel
   server process.
5. The channel server emits an MCP notification `notifications/claude/channel` with the content
   and `meta` (`session_id`, `message_id`).
6. Claude Code surfaces the inbound text in the running session as
   `<channel source="ccb" session_id="..." message_id="...">hello</channel>`.
7. Claude responds by calling the `bridge_reply` MCP tool (or `bridge_progress` /
   `bridge_done`), with `content`, `final:true`, and the inbound `messageId`.
8. The channel server's `onTool` callback forwards `{"type":"tool","name":"bridge_reply","args":...}`
   back over the same TCP control connection to the bridge's `ControlServer`.
9. The bridge translates the tool call into a `BridgeEvent` (`agent.progress`, `agent.reply`,
   `agent.done`), appends it to the JSONL store, and fans it out on the `EventBus`.
10. The consumer's `for await (const ev of bridge.events(sessionId))` loop yields the event.

## Why this shape

The bridge's only job is to be a clean integration surface for an interactive `claude` that is
already authenticated and running. Every alternative we considered for either direction either
re-spawns the model context, scrapes the terminal, or reduces the session to a one-shot — all
PLAN.md non-goals.

`claude --print` runs a single non-interactive turn and exits. It loses tool state, session
history, MCP server connections, and any prior context. It is fine for scripting one-off
prompts, but it cannot drive a long-lived interactive session, which is the whole point.

Terminal scraping (tmux `capture-pane`, ANSI parsing) is brittle. It breaks every time the
Claude Code UI changes, it has no semantic shape (a tool call and a paragraph of prose look
identical to a regex), and it requires constant maintenance. PLAN.md rules it out.

The Claude Agent SDK is the wrong primitive: it spawns a new model context for each invocation
rather than driving an existing one. The bridge wants to talk to an already-running, already-
authenticated `claude` — not to start a fresh agent loop with its own auth and config.

Channels exist for exactly this case. Anthropic introduced them so external tools can push
events into a running Claude Code session. The bridge declares the
`capabilities.experimental['claude/channel']` capability on its MCP server, registers three
outbound tools, and lets the model itself decide when to call them. The channel goes in; the
tools come out; the JSONL event log is the durable record.

| direction | mechanism | alternative considered | why not |
|---|---|---|---|
| inbound (bridge -> claude) | `notifications/claude/channel` | PTY write to stdin | brittle; shows up as user typing |
|   |   | spawn `claude --print` per turn | one-shot; loses interactive state |
|   |   | Claude Agent SDK | re-spawns the model context |
| outbound (claude -> bridge) | MCP tools `bridge_reply` / `bridge_progress` / `bridge_done` | terminal scraping / `capture-pane` | PLAN.md non-goal; breaks on UI changes |
|   |   | `claude --print --output-format stream-json` | one-shot; loses interactive state |
|   |   | Claude Agent SDK | re-spawns the model context |

## What channels + MCP doesn't give you

A richer UI (the T3 Code shape, an orchestrator that wants to render tool timelines) needs
things that channels + the three bridge tools don't carry on their own:

- Tool calls Claude makes mid-turn (Bash, Edit, Write, Read, Grep, Glob, ...).
- Mid-stream partial text (token-level streaming inside a single reply).
- Extended thinking blocks.
- Permission-prompt routing (the "Allow this tool?" interactive UX).

Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`, ...)
are the natural extension point for the first three. The `tool.event` variant of
`BridgeEvent` in `packages/core/src/events.ts` is reserved for hook-relayed payloads — it is
currently dead code waiting for a wire-up task. Hook relay is a future-milestone candidate;
the design space is sketched as M3 territory.

Token-level streaming is not on the roadmap. Every available path to it (the Agent SDK,
`--print --output-format stream-json`) re-violates the PLAN.md non-goals about the bridge not
being the model API's consumer. Channels deliberately deliver complete messages, not tokens.

## Where to go next

- `README.md` — install, run the demo, full CLI reference.
- `PLAN.md` — full design, directional communication discussion, process topology, package
  layout, original milestone 1 success criteria.
- `SMOKE.md` — manual real-claude smoke walkthrough (three terminals plus the plugin install
  variant).
- `M2.md` — next milestone: managed launch, supervisor-crash event emission, robustness
  fix-ups.
- `packages/core/src/events.ts` — the `BridgeEvent` union (the data contract every consumer
  sees).
- `packages/mcp-channel/src/channel-server.ts` — where `capabilities.experimental['claude/channel']`
  is declared and where the three bridge tools are registered.
- `packages/mcp-channel/src/control.ts` — the JSON-lines TCP control protocol that splices the
  bridge and channel-server processes together.
- [Channels reference](https://code.claude.com/docs/en/channels-reference) — Anthropic's
  protocol documentation for `notifications/claude/channel`.
