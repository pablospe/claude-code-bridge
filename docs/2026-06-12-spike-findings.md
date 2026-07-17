# Spike findings: channels permission relay (M5 Task 1)

**Date:** 2026-06-12
**claude version:** `2.1.175 (Claude Code)` (logged in, subscription)
**Outcome:** PASS — both phases verified against real claude on the `dev-flag` launch path.

Repro: `bun scripts/spike-permission/run.ts` (phase A) and
`bun scripts/spike-permission/run.ts --pre-approve` (phase B).

## Phase A — relay round-trip (default, no pre-approval)

- `sawRequest: true`, `proof: true`, `ok: true`.
- Latency (prompt typed → `permission_request` observed in log): **~4s**.
- Proof file written ~2s after the request (i.e. **~6s** after prompt), confirming
  the remote `allow` verdict actually unblocked the gated Bash call. The local
  terminal dialog was NOT answered by the driver — the relay verdict is what
  unblocked the tool.

### VERBATIM `permission_request` params observed

```json
{
  "request_id": "pjhrs",
  "tool_name": "Bash",
  "description": "Create proof file in spike directory",
  "input_preview": "{\"command\":\"touch /tmp/ccb-spike-Ke0qU5/proof.txt\",\"description\":\"Create proof file in spike directory\"}"
}
```

The full MCP notification method is
`notifications/claude/channel/permission_request`.

### Verdict reply (what unblocks the tool)

```json
{
  "method": "notifications/claude/channel/permission",
  "params": { "request_id": "pjhrs", "behavior": "allow" }
}
```

## Phase B — pre-approval via `--allowed-tools Bash`

- `sawRequest: false`, `proof: true`, `ok: true`.
- Proof written ~5s after prompt. NO `permission_request` notification fired —
  the tool ran directly. Confirms pre-approval suppresses the relay prompt
  entirely.

## Schema deviations — NONE

The documented schema is **exactly correct**. Critical facts for downstream tasks:

- Capability declaration: `capabilities.experimental` must contain BOTH
  `"claude/channel": {}` and `"claude/channel/permission": {}`. (The spike
  declared both; the permission capability is what enrolls the channel.)
- Notification in: `notifications/claude/channel/permission_request` with params
  `{ request_id, tool_name, description, input_preview }` — all four strings, all
  present. `input_preview` is a JSON-encoded **string** (the tool's raw input
  object serialized), NOT a nested object. snake_case field names throughout.
- Notification out: `notifications/claude/channel/permission` with params
  `{ request_id, behavior }`, `behavior ∈ {"allow","deny"}` (only `allow` was
  exercised live). snake_case.
- The documented zod schema parsed the live notification on the first try; the
  `fallbackNotificationHandler` capture path was never needed (no
  `raw_notification` entries were logged in either phase).

## `--allowed-tools` spelling fact

`--allowed-tools Bash` (flag with a space, value `Bash` — the bare tool name,
no `mcp__`/`builtin__` prefix) pre-approves the Bash builtin so no prompt fires.

## Timing quirks for future tasks

- Boot/confirm: blind `\r` dev-channels confirm at 500ms then every 3s (6 total,
  last at 15.5s); prompt typed at 18s. This kept all confirm writes clear of the
  permission dialog. Worked reliably across both runs.
- `request_id` is short (5 chars here, e.g. `"pjhrs"`); treat it as an opaque
  string, do not assume a UUID or any length.
- The relay verdict and the local terminal dialog race; first answer wins. The
  spike never answered the local dialog, so the remote `allow` alone unblocked
  the call — verified.
- MCP `initialize` completes fast (~90ms after connect); permission requests
  only arrive once the model actually attempts a gated tool (~4s after the
  prompt here, model-dependent).
