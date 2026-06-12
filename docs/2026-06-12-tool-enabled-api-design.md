# Design: Tool-enabled `ccb api` via M5 permission relay

**Date:** 2026-06-12
**Status:** Approved design
**Author:** Pablo Speciale

**Goal:** Implement the M5 permission relay (bridge-level, per [M5.md](./M5.md))
and a facade policy layer so `ccb api` can run pool sessions with Claude's
built-in tools enabled, answering permission prompts automatically from an
allowlist — API turns where Claude can act, not just answer.

**Resolved decisions:** (1) Both layers ship together: M5 core exactly per
M5.md, plus the facade policy. (2) Policy surface is a single allowlist flag
(`--allow-tools`), default off — no flag means today's raw-model mode,
unchanged. (3) Approach B: allowlisted tools are pre-approved at launch via
claude's `--allowedTools`, so the hot path pays zero prompt latency; the relay
is the fail-closed deny backstop for anything that still prompts. (4) A live
spike against real claude precedes the build, because M5.md flags the relay
protocol as unverified.

## Layer 1 — M5 core (per M5.md, no deviations)

`docs/M5.md` is the authoritative spec for this layer; this section is only an
index of its deliverables:

- **Wire:** `permission_request` (client→server) and `permission_response`
  (server→client) frames join `ControlMessageSchema` in
  `packages/mcp-channel/src/control.ts`. `ControlClient` gains
  `sendPermissionRequest(...)` + an `onPermissionResponse` callback;
  `ControlServer` gains `respond(sessionId, requestId, behavior)` + a
  `permission-request` event.
- **Channel server:** declares
  `capabilities.experimental["claude/channel/permission"] = {}` and registers
  the `notifications/claude/channel/permission_request` handler **only when
  `enablePermissionRelay` is set** (default off). The verdict notification
  routes through the same `oninitialized` gate as `deliver`.
- **Events:** new `BridgeEvent` variants `permission.requested`
  (`requestId`, `toolName`, `description`, `inputPreview`) and
  `permission.resolved` (`outcome: "allow" | "deny" | "unanswered-remotely" |
  "aborted" | "terminal"`; `"terminal"` reserved, never emitted).
- **Supervisor:** `respond?()` is **optional** on the `Supervisor` interface;
  only `ClaudeCodeSupervisor` implements it. New supervisor option
  `enablePermissionRelay`.
- **Bridge:** `respond(sessionId, requestId, behavior)` with the open-request
  registry per session, synchronous exactly-once close, persist-before-send
  ordering (`permission.resolved` is durable before the wire write), timeout
  recommendation (A) — on `permissionTimeoutMs` (default 120 000 ms) expiry the
  bridge stops tracking, emits `outcome:"unanswered-remotely"`, and sends **no
  verdict** — and abort-flush (`outcome:"aborted"`) of open requests on session
  close/crash.
- **Formatting:** two new `formatPretty` arms (forced by the exhaustiveness
  check).
- **Tests:** the full M5.md test matrix (round-trip allow/deny, timeout-A,
  multi-prompt out-of-order answers, unknown/closed requestId rejection,
  exactly-once under race, persist-vs-send failure injection both directions,
  abort on session end, disconnect mid-request, capability gating, formatter
  arms).

## Layer 2 — facade policy

### CLI surface

```
ccb api --allow-tools Read,Grep,Glob     # listed tools only
ccb api --allow-tools all                # everything (explicit opt-in)
ccb api                                  # no flag: raw-model mode, unchanged
```

- Comma-separated tool names, or the single special value `all`.
- Validation: names must be non-empty; `all` cannot be combined with names.
- No flag → today's behavior byte-for-byte: `rawModel: true`, no permission
  relay, no capability declared.

### Launch behavior with `--allow-tools`

- `rawModel: false` — the built-in tool denylist is not applied.
- Claude launches with `--allowedTools <list>` (exact flag spelling verified in
  the spike) so allowlisted tools run without prompting — zero added latency on
  the hot path. With `all`, no `--allowedTools` pre-approval is passed
  (there is no enumerable "everything"); every prompt reaches the relay and the
  policy answers allow.
- `enablePermissionRelay: true` on the supervisor, so anything that still
  prompts (MCP tools, unlisted tools, calls not covered by a blanket
  pre-approval) relays to the policy instead of hanging.

### PermissionPolicy

A small module in `packages/http` (`permission-policy.ts`):

```ts
interface PermissionPolicy {
  decide(toolName: string): "allow" | "deny";
}
createAllowlistPolicy(tools: ReadonlyArray<string> | "all"): PermissionPolicy
```

`decide` returns `"allow"` iff the tool is in the list (or the list is `all`),
else `"deny"`. Pure function of the tool name; `description`/`inputPreview`
are not consulted (no content sniffing — "no magic").

### Wiring

`SessionPool` owns session lifecycle and respawn, so it takes the policy as an
option. For each warm session (including respawns) it subscribes to
`bridge.events(sessionId)` and, on `permission.requested`, calls
`bridge.respond(sessionId, requestId, policy.decide(toolName))`. The
subscription is disposed when the session is closed/replaced.

- Policy answers are immediate — turns never wait on a human.
- A `respond` failure (e.g. request already aged out) is logged and swallowed:
  the turn either proceeds (claude got a terminal-side answer — impossible
  here, no terminal human — or the request aborted with the session) or fails
  via the existing turn timeout. Never fatal to the server.
- A denied tool call is not an error: claude sees the denial and answers in
  text, the same degradation philosophy as the facade's emulated tool calling.

### Safety

- Tool-enabled sessions act on **the working directory where `ccb api` was
  started** (claude inherits the server's cwd). Documented prominently in
  README/SMOKE: `--allow-tools Write,Edit,Bash` hands API callers real machine
  access.
- Server remains loopback-bound by default; docs recommend `--api-key`
  whenever write-capable tools are allowed.
- `permission.requested`/`permission.resolved` pairs land in the per-session
  JSONL store (M5 persistence), and executed calls are independently recorded
  by the M3 hook relay as `tool.event`s — so the audit trail does not depend
  on prompts firing.

## Spike (first task, throwaway)

M5.md: the relay protocol is unverified live, and inbound delivery is proven
only on the dev-flag launch path — which is what the facade pool already uses
(`channels: "dev-flag"` in `apps/ccb/src/api.ts`). Local claude is 2.1.174
(≥ 2.1.81 required). Before any production code:

1. Hand-wire a throwaway `setNotificationHandler` for
   `notifications/claude/channel/permission_request` into a scratch channel
   server with the capability declared; log the request and send back `allow`.
2. Drive a real claude session (dev-flag path) into a Bash call; verify the
   prompt arrives as a notification and the verdict unblocks the call.
3. Verify the `--allowedTools` flag spelling and that pre-approved tools do
   not prompt.
4. Record findings (including any protocol deviations) in the plan before the
   real tasks start. If the platform deviates from the docs, the design is
   revisited before implementation proceeds.

## Testing

- **Layer 1:** the M5.md test matrix, unit-level against mock control frames
  (no real claude required).
- **Layer 2:** allowlist parsing/validation (incl. `all` + names rejection),
  `createAllowlistPolicy` decisions, pool wiring with a mock supervisor that
  injects `permission_request` frames (assert verdicts, re-subscription on
  respawn, respond-failure swallowing), CLI flag tests, launch-arg assembly
  (`--allowedTools` passed iff a named list; absent for `all` and for raw-model
  mode).
- **Live smoke:** a documented SMOKE.md entry driving `ccb api
  --allow-tools ...` end-to-end — an API request whose answer requires a real
  tool call (e.g. reading a file), plus a denied-tool request showing graceful
  text degradation.

## Out of scope

- Everything M5.md lists as out of scope (project-trust dialogs, deny reasons,
  verdict acknowledgement, `events({since})` replay).
- Per-request or per-API-caller policies (one allowlist per server process).
- Argument-level rules (e.g. `Bash(npm:*)` patterns) — the policy keys on tool
  name only; pattern rules can ride on `--allowedTools` pass-through later.
- A `--workdir` flag — sessions inherit the server's cwd; start the server
  where you want claude to act.
- Surfacing permission events to API clients over the OpenAI/Anthropic wire
  (no place for them in either dialect).
