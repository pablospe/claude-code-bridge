# Real Claude Code Smoke Procedure

This document describes how to verify the end-to-end Claude Code Bridge loop against a real `claude` process. The automated test track in `bun test` covers the protocol shape via the `MockSupervisor`; this document covers the manual real-claude track that was the second deliverable of Milestone 1.

Managed launch (the bridge spawning `claude` itself via node-pty) is intentionally deferred. Until that lands, the human starts `claude` in a second terminal and the bridge runs in the foreground of the first.

## Prerequisites

- `bun` on `PATH`.
- `claude` CLI version 2.1.80 or newer.
- Channels are a Claude Code research-preview feature. `claude` must be launched with `--dangerously-load-development-channels server:ccb` for the bridge channel to be exposed; this flag will not be required forever, but it is required during the preview window.
- A real terminal. The `claude` boot path checks for a TTY on stdout and bails to `--print` mode otherwise (verified empirically by the bridge research). There is no fully-headless scripted variant for this reason.

## Manual procedure (three terminals)

The helper `scripts/smoke-manual.sh` mints a session id, writes the per-session `.mcp.json`, prints the exact command to run in the other terminal, and then hosts the bridge in the foreground.

### Terminal 1 — host the bridge

```bash
./scripts/smoke-manual.sh
```

Sample startup output:

```
ccb manual smoke
================
session_id        : 4f3b6e10-1234-4abc-9def-feedfacecafe
control endpoint  : 127.0.0.1:18484
mcp config        : /tmp/ccb-smoke-4f3b6e10-...mcp.json
store dir         : .ccb-data

In a second terminal run:

  claude --dangerously-load-development-channels server:ccb --mcp-config /tmp/ccb-smoke-...mcp.json

Then in claude, send a message that prompts it to call the bridge_reply tool.
Watch this terminal for the live event stream. Press Ctrl-C to stop.

listening on 127.0.0.1:18484; session_id=4f3b6e10-...; waiting for channel server to connect...
bridge_uuid: <bridge-uuid>
jsonl: .ccb-data/<bridge-uuid>.jsonl
[session.started] <bridge-uuid>
```

The `bridge_uuid` and `jsonl` lines are emitted to stderr at startup so you
can locate the per-session log without grepping for the bridge id in the event
stream.

The script honors these environment overrides:

| variable              | default     | meaning                                  |
| --------------------- | ----------- | ---------------------------------------- |
| `CCB_SMOKE_HOST`      | `127.0.0.1` | bind host for the bridge control server  |
| `CCB_SMOKE_PORT`      | `18484`     | loopback TCP port                        |
| `CCB_SMOKE_STORE_DIR` | `.ccb-data` | per-session JSONL output directory       |

### Terminal 2 — start claude

Copy the exact `claude` command the script printed and run it. `claude` will spawn `bunx ccb-channel-server` as a stdio child, the channel server will dial `127.0.0.1:18484`, and the `ControlServer` in Terminal 1 will accept the hello.

Inside `claude`, ask something that exercises the bridge tools. The channel server installs three tools — `bridge_reply`, `bridge_progress`, `bridge_done` — and the channel-server `instructions` tell `claude` when to call each one.

### Terminal 1 (after claude is up) — exercise the inbound channel

Switch back to Terminal 1 (the one running `ccb serve`). With `claude` running in Terminal 2 and the channel server connected, type a line of text in Terminal 1 and press enter. The bridge reads stdin line-by-line and forwards each line through the control connection as a `notifications/claude/channel` envelope. Without this step the smoke only exercises the outbound (`bridge_reply` / `bridge_progress` / `bridge_done`) half.

### Terminal 3 (optional) — inspect the JSONL log

```bash
tail -f .ccb-data/<session-uuid>.jsonl
```

The bridge persists every `BridgeEvent` to `.ccb-data/<session-uuid>.jsonl` as it is emitted. Note the file is keyed by the bridge's internal session UUID, which is independent of the wire session id passed to `--session-id`. The bridge UUID is printed as part of `[session.started]` in Terminal 1.

## What to look for

In Terminal 1 you should see, in roughly this order:

```
[session.started] <bridge-uuid>
listening on 127.0.0.1:18484; session_id=<wire-uuid>; waiting for channel server to connect...
[message.sent] <message-id> "..."           # if you type a line into stdin
[agent.progress] "..."                       # whenever claude calls bridge_progress
[agent.reply final=true] "..."               # final assistant turn
```

Pressing Ctrl-C cleanly closes the bridge: it tears down the control server, drains in-flight store writes, and emits `[session.ended]`.

## Scripted variant (best-effort)

`scripts/smoke-scripted.ts` automates the same flow with one major caveat: `claude` requires a TTY at boot. The script is gated on `CCB_RUN_REAL_CLAUDE=1` and skips with a notice when the gate is not set. When the gate is set and `claude` refuses to boot under a piped stdio handle, the script logs `skipped: claude refused headless boot (needs a TTY)` and exits 0.

```bash
CCB_RUN_REAL_CLAUDE=1 bun scripts/smoke-scripted.ts
```

Do not depend on this in CI without a PTY surrogate. The intent is to give a single-command path for local experimentation; production-grade automation is what managed launch (post-M1) will deliver.

## Known limitations

- **Managed launch deferred.** The bridge does not spawn `claude` itself in M1. Tracking item for M2: wrap `claude` in `node-pty` so its boot-time TTY check passes while keeping reply/progress data off the PTY.
- **TTY requirement.** Because `claude` exits to `--print` mode when stdout is not a TTY, there is no fully automated scripted smoke. The scripted variant above is best-effort only.
- **Research-preview channels.** The `--dangerously-load-development-channels server:ccb` flag is required during the channels research preview. Once `claude/channel` is on the approved allowlist, that flag will no longer be needed.
- **Bridge UUID vs wire UUID.** The `--session-id` flag is the wire id the channel server speaks to the bridge with. The bridge mints its own internal UUID for events and the JSONL store. They are intentionally independent.

## Channels availability gate

The channels feature is gated at runtime independent of the command-line flag. If `claude --debug` logs

```
MCP server "ccb": Channel notifications skipped: channels feature is not currently available
```

then the MCP server connected and its tools registered, but channel notifications cannot be delivered. The bridge wire is correct; the gate is on `claude`'s side.

Per the [channels overview](https://code.claude.com/docs/en/channels) the gate works like this:

- **Pro / Max users without an organization**: channels are available by default. If you still hit the gate, verify your `claude` session authenticated through claude.ai or a Console API key — channels are not available on Amazon Bedrock, Google Vertex AI, or Microsoft Foundry.
- **claude.ai Team / Enterprise**: channels are blocked until an admin enables them at [claude.ai → Admin settings → Claude Code → Channels](https://claude.ai/admin-settings/claude-code), or by setting `channelsEnabled: true` in managed settings.
- **Anthropic Console with API key authentication**: channels are permitted by default unless your organization deploys managed settings that override it. If they do, the admin needs to set `channelsEnabled: true` in those managed settings.

`--dangerously-load-development-channels` bypasses the published-plugin allowlist (so `server:ccb` can register without being on the Anthropic-curated list), but it **does not** bypass `channelsEnabled`. If the master switch is off, the dev flag has no effect.

Updating the `claude` CLI does not change this — the gate is on the account/org tier, not the version. As long as `claude --version` reports `2.1.80` or newer, you have the right binary; what may be missing is the org-side opt-in.

To verify the gate independently of this project, you can install the official `fakechat` demo channel and try to send a message — if fakechat works in your environment, this project will too:

```bash
/plugin install fakechat@claude-plugins-official
# exit and restart with the channel
claude --channels plugin:fakechat@claude-plugins-official
# open http://localhost:8787 and type a message
```

If fakechat also hits the gate, that confirms the issue is the org/account policy, not anything specific to `ccb`.
