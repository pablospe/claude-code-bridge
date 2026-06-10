# OpenAI-compatible facade over a warm Claude Code session pool

Status: design approved in discussion, pending spec review.

## Goal

Expose a logged-in interactive Claude Code session as an OpenAI-compatible
HTTP API so LiteLLM (and any OpenAI-speaking client) can use it
programmatically. Each API request becomes one turn in a live session that
stays open between requests; `/clear` between requests replaces a cold
restart, so per-request warm-up cost is near zero.

LiteLLM requires **no code changes**. It consumes the facade as a generic
OpenAI endpoint:

```yaml
# litellm proxy config.yaml
model_list:
  - model_name: ccb-claude
    litellm_params:
      model: openai/ccb-claude
      api_base: http://127.0.0.1:18485/v1
      api_key: "ccb"        # facade ignores it unless a shared secret is configured
```

This stays within the project premise: the driven session is an interactive
session in the interactive billing pool. The pool size bounds concurrency and
acts as the deliberate rate limiter.

## Non-goals

- Headless `claude -p` / Agent SDK usage (project non-goal).
- Faithful `temperature` / `top_p` / `max_tokens` / `n` / `logprobs` /
  `response_format` support — accepted and ignored (logged once per server
  run).
- Exact token accounting — `usage` is estimated (`~chars/4`) and documented
  as such.
- Token-granular streaming — chunks are message-sized (see Streaming).
- Multi-model routing — `model` is echoed back verbatim; the actual model is
  whatever the session runs.

## Architecture

New package `packages/http` (the slot ROADMAP.md reserves) plus a `ccb api`
CLI command in `apps/ccb`.

```
LiteLLM ──HTTP──▶ packages/http (Bun.serve)
                    │  POST /v1/chat/completions
                    │  GET  /v1/models
                    ▼
                  SessionPool (N warm sessions, queue)
                    │ acquire → clear → sendMessage → events → release
                    ▼
                  @ccb/core Bridge ──▶ ClaudeCodeSupervisor (PTY, clean mode)
```

Components, one purpose each:

| Component | Package | Responsibility |
|---|---|---|
| HTTP server | `packages/http` | Parse/validate OpenAI requests, SSE framing, error shaping |
| `SessionPool` | `packages/http` | N warm sessions, one in-flight turn each, FIFO queue, crash respawn |
| Transcript renderer | `packages/http` | `messages[]` + `tools[]` → single prompt string |
| Tool-call parser | `packages/http` | Final reply → `tool_calls` or plain text |
| `bridge.clear(sessionId)` | `packages/core` + `packages/claude-code` | Inject `/clear` into the idle session's PTY |
| `cleanSession` launch option | `packages/claude-code` | Spawn the driven session without operator customizations |

## Request lifecycle (stateless)

The OpenAI API is stateless: every request carries the full `messages`
array. The facade therefore treats every request independently — no session
affinity, no conversation bookkeeping:

1. **Acquire** a session from the pool (or queue FIFO if all busy).
2. **Clear** it via `bridge.clear()` — safe because the pool only hands out
   idle sessions.
3. **Render** the entire `messages` array into one prompt (see Rendering)
   and `sendMessage` it as a single turn.
4. **Collect** `events()` until `agent.reply{final:true}` or `agent.done`
   (both are turn-terminal; treating only one would hang).
5. **Parse** the reply for a tool-call block; respond in OpenAI shape.
6. **Release** the session back to the pool.

Trade-off, accepted: long conversations replay their full history each
request. In exchange, retries, history edits, parallel clients, and tool
round-trips all work with zero affinity logic.

## Clean session launch

The operator's real `~/.claude` is full of plugins (claude-mem), hooks, and
MCP servers that must not load into driven sessions. Current dev-flag mode
already passes `--strict-mcp-config`, `--setting-sources project,local`, and
`--disable-slash-commands`, but **plugins and hooks still load** — that is
the gap.

Decision (verified empirically on claude 2.1.170): a `cleanSession: true`
supervisor option implemented as the dev-flag trim **minus**
`--disable-slash-commands`. It keeps `--strict-mcp-config` and
`--setting-sources project,local`; on claude >= 2.1.169 that user-tier
exclusion also drops user-enabled plugins (claude-mem) and user hooks, which
is the cleanliness we want. `--disable-slash-commands` is omitted so `clear()`
can type `/clear` into the TUI. Only valid with **dev-flag channel mode**:
plugin mode resolves ccb's channel through the user tier this exclusion
removes. Do **not** add `--settings '{"disableAllHooks":true}'` — it breaks the
channels-to-MCP binding the same way.

Two candidates were rejected by the first smoke test:

- **`--safe-mode`** disables ALL MCP servers, including the explicitly passed
  `--mcp-config` channel, so the bridge channel never connects and
  `startSession` times out.
- **`CLAUDE_CONFIG_DIR=<fresh dir>`** lets the MCP server connect and inbound
  delivery work, but the channels-to-MCP binding fails ("no MCP server
  configured with that name") so claude replies in the TUI instead of calling
  `bridge_reply` — the env var is only partially respected (a claude bug).

`raw-model mode` is independent of cleanliness: pool sessions also launch
with Claude Code's own tools disallowed, so the only output path is
`bridge_reply`. The session behaves like a bare model rather than an agent
that does the work itself.

## Rendering: `messages[]` → one prompt

- `system` messages become a preamble block.
- History becomes labeled turns: `[user]`, `[assistant]`,
  `[assistant tool_call]`, `[tool result for <id>]`.
- If `tools` are present: schemas are embedded as JSON, followed by the
  instruction — *"If you need a tool, reply with ONLY a fenced JSON block:
  `{"tool_call": {"name": ..., "arguments": {...}}}` (array for multiple
  calls). Otherwise reply normally."* Reinforced via
  `--append-system-prompt` at launch (works in interactive mode).

## Tool calling (emulated)

OpenAI contract: the **client** executes functions; the facade only
translates.

- Request with `tools` → rendered as above → Claude replies with the JSON
  block → parser emits `tool_calls` with generated ids
  (`finish_reason: "tool_calls"`).
- The follow-up request containing `role: "tool"` results is just another
  stateless request — the results replay as labeled history.
- **Degradation, never a 500:** if the reply contains no parseable block,
  return it as plain text with `finish_reason: "stop"`. No schema
  enforcement (`strict: true` unsupported); parallel calls best-effort via
  the array form.

## Streaming

`stream: true` → real SSE. `agent.progress` and non-final `agent.reply`
events become content-delta chunks as they arrive. Granularity is at
Claude's discretion (message-sized, possibly a single chunk) — valid
protocol, no typewriter feel. When `tools` are present, output is buffered
until turn end so a detected tool call is emitted as one `tool_calls` chunk
before `[DONE]`.

## Errors

- Per-turn timeout (configurable, default generous — minutes, since a turn
  may think long) → 504 in OpenAI error shape.
- `agent.done` with an error reason → 500 in OpenAI error shape.
- Session crash → respawn into the pool; the affected request retries once
  on a fresh session before failing.
- Malformed request (no `messages`, bad JSON) → 400.
- Optional shared-secret check on `Authorization` (off by default,
  loopback-only default bind).

## Configuration

`ccb api` flags (explicit, no guessing):

- `--port` (default 18485), `--host` (default 127.0.0.1)
- `--pool-size` (default 1)
- `--turn-timeout-ms` (default 300000)
- `--api-key` (optional shared secret)

## Testing (outside-in TDD)

Red-first ordering; each component gets a failing test before code.

1. **Acceptance (red first):** smoke script — start `ccb api`, run
   `litellm.completion(model="openai/ccb-claude", api_base=...)` from a
   minimal Python script, assert a reply. Written before the server exists.
2. **Unit, against `mockSupervisorFactory` (fast, no real claude):**
   - transcript renderer (system/history/tools/tool-results cases)
   - tool-call parser (block, array, prose fallback, malformed JSON)
   - session pool (acquire/queue/release ordering, crash respawn, clear-
     before-turn invariant)
   - SSE chunk shape (deltas, tool_calls chunk, `[DONE]`, usage estimate)
   - request validation and error shapes
3. **Real-claude smokes (documented commands, SMOKE.md):**
   - clean boot: spawn with `cleanSession`, assert channel connects and no
     operator plugins/hooks are present — **smoke #1; RESOLVED: cleanSession =
     the user-tier exclusion without `--disable-slash-commands`; safe-mode and
     CLAUDE_CONFIG_DIR rejected (see "Clean session launch")**
   - `/clear` injection: two requests, assert the second sees no first-
     request context
   - tool round-trip: `tools` request → `tool_calls` → `role:"tool"`
     follow-up → final answer
   - streaming via `litellm.completion(stream=True)`

## Risks

- **`--safe-mode` severs the dev-flag channel** — confirmed by smoke #1, so
  `cleanSession` uses the user-tier exclusion instead (see "Clean session
  launch").
- **`/clear` PTY injection** assumes an idle session with an empty input
  box; pool discipline guarantees idleness, the smoke test guarantees the
  write itself works.
- **Prompted tool calls are not schema-enforced** — a stubborn reply
  degrades to text; clients must tolerate it (the real API permits it).
- **Facade makes it easy to hammer an interactive session** — pool size is
  the deliberate throttle; no additional rate limiting in v1 (YAGNI).
