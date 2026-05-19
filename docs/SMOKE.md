# Real Claude Code Smoke Procedure

This document describes how to verify the end-to-end Claude Code Bridge loop against a real `claude` process. The automated test track in `bun test` covers the protocol shape via the `MockSupervisor`; this document covers the real-claude track.

Managed launch is the primary path: the bridge spawns and supervises `claude` itself via `node-pty`, so a single command drives one terminal end-to-end. The two-terminal manual procedure is preserved as a fallback for hosts where `node-pty` cannot build/load.

## Managed launch (recommended)

One command, one terminal, no human in the loop beyond `claude` already being authenticated:

```bash
bun apps/ccb/src/cli.ts demo --supervisor=claude --channels=dev-flag "your prompt"
```

This selects the `ClaudeCodeSupervisor`, which:

- Spawns `claude` under `node-pty` (the boot-time TTY check is what makes the PTY necessary).
- Generates a per-session `.mcp.json`, passes it via `--mcp-config`, and cleans up on close.
- In `--channels=dev-flag` mode, runs `claude --dangerously-load-development-channels server:ccb` and auto-confirms the boot warning. Use `--channels=plugin` once you have installed the local plugin (see "Installing as a plugin" below) to avoid the warning entirely.
- Reaps the spawned `claude` on `bridge.close()`; no orphan processes survive a clean shutdown.

Preconditions: `claude` on `PATH`, already authenticated (`claude login` at least once), and channels available to your account (see "Channels availability gate" below). If `node-pty` fails to load on the host, the supervisor throws `LauncherUnavailableError` and you should use the manual fallback below.

## Prerequisites

- `bun` on `PATH`.
- `claude` CLI version 2.1.80 or newer.
- Channels are a Claude Code research-preview feature. `claude` must be launched with `--dangerously-load-development-channels server:ccb` for the bridge channel to be exposed; this flag will not be required forever, but it is required during the preview window.
- A real terminal. The `claude` boot path checks for a TTY on stdout and bails to `--print` mode otherwise (verified empirically by the bridge research). There is no fully-headless scripted variant for this reason.

## Manual fallback: two-terminal procedure

(Two terminals minimum — Terminal 1 hosts the bridge and reads your prompt from stdin; Terminal 2 runs `claude`. The optional Terminal 3 in the steps below is only for tailing the JSONL log; it carries no role in the protocol.)

The procedure below is the fallback for hosts where `node-pty` cannot build or load (managed launch raises `LauncherUnavailableError` in that case). It is also the original M1 verification path and is preserved verbatim.

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

By default, `claude` will prompt for permission the first time the bridge calls a tool (`bridge_reply`, `bridge_progress`, or `bridge_done`). To skip those prompts narrowly, append the `--allowed-tools` flag the script suggests:

```bash
claude --dangerously-load-development-channels server:ccb \
  --mcp-config /tmp/ccb-smoke-<uuid>.mcp.json \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

This auto-approves only those three MCP tools. All other permission checks (Bash, Edit, Write, etc.) stay gated. **Do not** use `--dangerously-skip-permissions` for this — that flag bypasses every permission check, not just the bridge's, and is overkill when `--allowed-tools` does the job.

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

## Installing as a plugin (no dev-flag warning)

The procedure above uses `--dangerously-load-development-channels server:ccb`, which works but prints a startup warning every time `claude` boots and requires a per-session `--mcp-config` file. The cleaner alternative is to install ccb as a Claude Code plugin from the local marketplace declared in this repo. Once installed and added to `allowedChannelPlugins`, the dev flag is no longer required.

### One-time install

1. Start a `claude` session anywhere and run these slash commands:

   ```
   /plugin marketplace add /home/pablo/code/claude-code-bridge
   /plugin install ccb@ccb-local
   ```

   The first command points at the repo root (substitute your own checkout path) where `.claude-plugin/marketplace.json` lives. The second installs the `ccb` plugin from that marketplace.

2. Tell `claude` it is allowed to expose the channel by adding `allowedChannelPlugins` to `~/.claude/settings.json`:

   ```json
   {
     "allowedChannelPlugins": [
       { "marketplace": "ccb-local", "plugin": "ccb" }
     ]
   }
   ```

### Running with the plugin channel

Start `claude` from the repo root (so `${CLAUDE_PROJECT_DIR}` in the plugin manifest resolves to this workspace) with:

```bash
claude --channels plugin:ccb@ccb-local \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

Expected outcome:

- No `--dangerously-load-development-channels` flag and no startup warning prompt about loading development channels.
- The channel server is spawned by `claude` from the plugin manifest's `mcpServers.ccb` entry, which runs `bun ${CLAUDE_PROJECT_DIR}/packages/mcp-channel/src/bin.ts`.
- The bridge (`scripts/smoke-manual.sh` in another terminal, `ccb serve` directly, or the managed-launch supervisor in the single-command path) still owns the control endpoint. The plugin manifest declares `CCB_BRIDGE_ENDPOINT` and `CCB_SESSION_ID` as env keys; the bridge populates them at session start by injecting overrides into the spawn.
- All other gating still applies: `tengu_harbor` must be enabled server-side and channels must be available to your account (see "Channels availability gate" below).

The `--dangerously-load-development-channels server:ccb` path described above stays supported as a fallback for users who do not want to install the plugin.

## Scripted variant (best-effort)

`scripts/smoke-scripted.ts` automates the same flow with one major caveat: `claude` requires a TTY at boot. The script is gated on `CCB_RUN_REAL_CLAUDE=1` and skips with a notice when the gate is not set. When the gate is set and `claude` refuses to boot under a piped stdio handle, the script logs `skipped: claude refused headless boot (needs a TTY)` and exits 0.

```bash
CCB_RUN_REAL_CLAUDE=1 bun scripts/smoke-scripted.ts
```

Do not depend on this in CI without a PTY surrogate. The intent is to give a single-command path for local experimentation; the supported single-command path for real `claude` is managed launch (`bun apps/ccb/src/cli.ts demo --supervisor=claude "..."`).

## Diagnostic harness (when managed launch fails opaquely)

`scripts/diagnostics/claude-pty-trace.cjs` is a pure-Node script that mimics what `ClaudeCodeSupervisor` does to spawn `claude`, tees every PTY byte to a log file, and auto-confirms the dev-channels warning the same way the supervisor does. Its purpose is to make `claude`'s PTY output observable on runtimes where the production supervisor cannot — most notably Bun, whose NAPI compat layer does not surface `node-pty`'s `onData` callbacks. With the harness you can see what `claude` actually prints during boot, between the dev-channels confirm and the channel-server spawn, and after a channel notification arrives.

Use it when managed launch (`ccb demo --supervisor=claude`) hangs at `supervisor.start timed out` or produces `agent.done reason=channel-disconnected` instead of a real reply, and you want to know what `claude` was doing inside the PTY.

### Setup

```bash
# 1. Pick a fixed endpoint + session id so all three pieces agree:
SESSION_ID=$(uuidgen)
ENDPOINT=127.0.0.1:18486

# 2. In one terminal, host the bridge with a delayed stdin so the message is
#    sent after the channel server has had time to connect. The
#    ControlServer.deliver hello-gate (default 30s) tolerates moderate
#    timing skew, but a generous pre-delay removes the race entirely:
( sleep 25 && echo "what is 11 squared?" && sleep 90 ) \
  | bun apps/ccb/src/cli.ts serve \
      --endpoint "$ENDPOINT" --session-id "$SESSION_ID" \
      --format json > /tmp/ccb-verify-serve.log 2>&1 &

# 3. In a second terminal (real TTY required), launch the harness pointed at
#    the same bridge. NODE_PATH resolves @homebridge/node-pty-prebuilt-multiarch
#    from the workspace's isolated install layout.
NODE_PATH="$PWD/packages/process/node_modules" \
  node scripts/diagnostics/claude-pty-trace.cjs \
    --endpoint "$ENDPOINT" --session-id "$SESSION_ID"

# 4. Watch the bridge's JSONL event stream and the PTY trace log:
tail -f /tmp/ccb-verify-serve.log
tail -f /tmp/claude-pty-trace.log
```

A successful run produces the canonical reply chain in the bridge log:

```jsonl
{"type":"session.started", ...}
{"type":"message.sent", ..., "content":"what is 11 squared?"}
{"type":"agent.reply", ..., "content":"11 squared is 121.", "final":true}
{"type":"agent.done", ...}
```

### Why the harness exists

`ClaudeCodeSupervisor` reads claude's PTY via `node-pty`'s `onData` callback. Under Bun on Linux at the time of writing, NAPI gaps prevent that callback from firing reliably — the supervisor cannot see what `claude` prints, so debugging managed-launch failures is blind. The harness sidesteps Bun by spawning `claude` from a Node process where `node-pty`'s `onData` works, then logs every byte. The bridge itself (the `ccb serve` half above) still runs under Bun and exercises the production code path.

### When it is more than diagnostic

The harness pairs `ServeSupervisor` (under Bun) with an external `claude` launcher (under Node) — the same pattern any process orchestrator would use. It is the **current best Linux+Bun real-claude path** until Bun's NAPI gap closes. See `docs/ARCHITECTURE.md` § "Choosing a supervisor" for the broader story; the short version is that `ClaudeCodeSupervisor` is a convenience layer and `ServeSupervisor` + external launcher is the load-bearing pattern. The harness happens to be a perfectly good external launcher: 200 lines of clear Node, observable PTY output, the same auto-confirm logic the production supervisor uses.

If you want to ship this pattern beyond local development, the harness only needs a CLI rename, slightly nicer docs, and a `bin` entry — no new code.

### CLI options

- `--endpoint <host:port>` — bridge control endpoint (default `127.0.0.1:18484`).
- `--session-id <uuid>` — required; must match the bridge's `--session-id`.
- `--log <path>` — PTY trace log file (default `/tmp/claude-pty-trace.log`).
- `--mcp-config <path>` — override the temp `.mcp.json` path the harness writes.

The harness exits when `claude` exits. Ctrl-C tears down `claude` and removes the temp config.

### Common diagnoses

| symptom in `/tmp/claude-pty-trace.log` | likely cause |
|---|---|
| WARNING block prints but no `Enter to confirm` line | claude's UI text drifted; update the supervisor's hint constant |
| Hint visible but no further activity | auto-confirm `\r` isn't reaching claude; check the harness's `[harness] auto-confirm` lines for write failures |
| Banner renders, then the channel-server bin's `connect()` shows `ECONNREFUSED` | bridge isn't listening on the endpoint the harness's `.mcp.json` advertises |
| Channel server appears in `ps -ef`, TCP `ESTAB` to the bridge, but `inject failed: no connected client` in the bridge log | hello arrived after the bridge tried to deliver; the `ControlServer.deliver` hello-gate (default 30s) tolerates this, but check both timestamps |

## Known limitations

- **Managed launch requires `node-pty`.** The supervisor wraps `claude` in `node-pty` to satisfy its boot-time TTY check while keeping reply/progress data off the PTY. If `node-pty` cannot build/load on the host, `ClaudeCodeSupervisor.start` throws `LauncherUnavailableError` and the two-terminal fallback above is the supported path.
- **TTY requirement.** Because `claude` exits to `--print` mode when stdout is not a TTY, the scripted smoke that does not use the managed-launch PTY is best-effort only. Managed launch resolves this end-to-end.
- **Research-preview channels.** The `--dangerously-load-development-channels server:ccb` flag is required during the channels research preview. Once `claude/channel` is on the approved allowlist, that flag will no longer be needed.
- **Bridge UUID vs wire UUID.** The `--session-id` flag is the wire id the channel server speaks to the bridge with. The bridge mints its own internal UUID for events and the JSONL store. They are intentionally independent.

## Channels availability gate

The channels feature is gated at runtime independent of the command-line flag. If `claude --debug` logs

```
MCP server "ccb": Channel notifications skipped: channels feature is not currently available
```

then the MCP server connected and its tools registered, but channel notifications cannot be delivered. The bridge wire is correct; the gate is on `claude`'s side.

The published behavior model (per [channels overview](https://code.claude.com/docs/en/channels)) is:

- **Pro / Max users without an organization**: channels available by default.
- **claude.ai Team / Enterprise**: blocked until an admin enables at [claude.ai → Admin settings → Claude Code → Channels](https://claude.ai/admin-settings/claude-code) or via `channelsEnabled: true` in managed settings.
- **Anthropic Console with API key authentication**: permitted by default unless managed settings override.
- Channels are unavailable on Amazon Bedrock, Google Vertex AI, Microsoft Foundry — only direct Anthropic auth.

**What actually happens in practice** (see [`anthropics/claude-code#36460`](https://github.com/anthropics/claude-code/issues/36460), still open at last check):

There is a server-side GrowthBook feature flag called `tengu_harbor` that gates channels independently of the documented `channelsEnabled` setting. The flag is rolling out gradually. Many personal Pro/Max accounts hit the "channels feature is not currently available" message even though the published behavior says channels should be available by default. The admin-settings page does not exist for personal accounts (the auto-generated `<your-email>'s Organization` is a shadow org with no UI), so the doc's "have an admin enable it" advice has no actionable target for personal users.

**Diagnostic first.** Check your local cache for the flag value:

```bash
jq '.cachedGrowthBookFeatures.tengu_harbor' ~/.claude.json 2>/dev/null
```

- `true` → the flag IS enabled for your account server-side. The block is local — see the "local-side blockers" below.
- `false` or `null` → the flag is NOT enabled for your account server-side. No local config fixes this; comment on the GitHub issue to request being opted in, or wait for the rollout.

**Local-side blockers** (when the flag is enabled server-side but channels still don't work):

1. Telemetry env vars **disable feature-flag evaluation entirely**, not just network telemetry. If any of these are set, unset them, open a fresh shell, then `claude auth logout && claude auth login`:
   - `DISABLE_TELEMETRY`
   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
   - `CLAUDE_CODE_USE_BEDROCK`, `_USE_VERTEX`, `_USE_FOUNDRY`

   Also check `~/.claude/settings.json` and `~/.zshrc` / `~/.bashrc` / `~/.zprofile`.

2. `--dangerously-load-development-channels` bypasses the **plugin allowlist** (so a custom `server:ccb` can register without being on the Anthropic-curated list), but it does **not** bypass `tengu_harbor` or `channelsEnabled`.

3. Updating the `claude` CLI does not change this. As long as `claude --version` is `2.1.80` or newer, the binary is fine; the gate is on the account-side flag.

**Independent verification.** Install the official `fakechat` demo channel — if it doesn't work either, the issue is account-side, not anything specific to this project:

```bash
# inside a running claude session:
/plugin install fakechat@claude-plugins-official
# exit and restart with the channel:
claude --channels plugin:fakechat@claude-plugins-official
# open http://localhost:8787 and type a message
```

If fakechat hits the same gate, you're waiting on `tengu_harbor` rollout. If fakechat works, but `ccb` doesn't, that's something to debug in this project specifically.
