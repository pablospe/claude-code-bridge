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

Copy the exact `claude` command the script printed and run it. `claude` will spawn the channel server defined in the generated `.mcp.json` (the script wires it to `bun <repo>/packages/mcp-channel/src/bin.ts`) as a stdio child, the channel server will dial `127.0.0.1:18484`, and the `ControlServer` in Terminal 1 will accept the hello.

By default, `claude` will prompt for permission the first time the bridge calls a tool (`bridge_reply`, `bridge_progress`, or `bridge_done`). To skip those prompts narrowly, append the `--allowed-tools` flag the script suggests:

```bash
claude --dangerously-load-development-channels server:ccb \
  --mcp-config /tmp/ccb-smoke-<uuid>.mcp.json \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

This auto-approves only those three MCP tools. All other permission checks (Bash, Edit, Write, etc.) stay gated. **Do not** use `--dangerously-skip-permissions` for this — that flag bypasses every permission check, not just the bridge's, and is overkill when `--allowed-tools` does the job.

Inside `claude`, ask something that exercises the bridge tools. The channel server installs three tools — `bridge_reply`, `bridge_progress`, `bridge_done` — and the channel-server `instructions` tell `claude` when to call each one.

### Terminal 1 (after claude is up) — exercise the inbound channel

Switch back to Terminal 1 (the one hosting the bridge). With `claude` running in Terminal 2 and the channel server connected, type a line of text in Terminal 1 and press enter. The bridge reads stdin line-by-line and forwards each line through the control connection as a `notifications/claude/channel` envelope. Without this step the smoke only exercises the outbound (`bridge_reply` / `bridge_progress` / `bridge_done`) half.

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

## Installing as a plugin (outbound + hooks only — see inbound caveat)

The procedure above uses `--dangerously-load-development-channels server:ccb`, which works but prints a startup warning every time `claude` boots and requires a per-session `--mcp-config` file. Installing ccb as a Claude Code plugin avoids the warning and gives you the **outbound** bridge tools (`bridge_reply` / `bridge_progress` / `bridge_done`) plus the **M3 hook relay** (`tool.event` records).

> **Inbound does NOT work via the plugin path on an individual (Pro/Max) account (verified 2026-05-21).** With the plugin, `claude --channels plugin:ccb@<marketplace>` reports `… · not on the approved channels allowlist` and silently drops inbound channel messages. This is by design during the channels research preview — not a misconfiguration. Per the [channels docs](https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run): `--channels` only registers plugins on the **Anthropic-maintained approved allowlist** (the `claude-plugins-official` channels). `allowedChannelPlugins` *can* replace that allowlist with your own list — but it is a **Team/Enterprise managed-settings (admin)** control; individual Pro/Max accounts ignore it and always fall back to the Anthropic default list. So a self-published plugin like ccb **cannot** be allowlisted on an individual account; the only two doors are Anthropic curating ccb onto `claude-plugins-official`, or a Team/Enterprise admin allowlisting it for an org. The plugin still gives you the **outbound** tools + the **M3 hook relay**; only inbound is gated.
>
> For full bidirectional behaviour (inbound prompts AND outbound replies) on an individual account, use the `--mcp-config` + `--dangerously-load-development-channels server:ccb` path — what `ccb serve` prints, and the only path proven to round-trip. That dev flag bypasses the allowlist **per-entry**, but it shows a confirmation warning on **every** launch (there is no documented flag/env to suppress it — being warning-free requires an *approved* channel, which routes back to the allowlist gate above). On the managed path the supervisor auto-dismisses that warning, so an operator driving the bridge never sees it; only a manual two-terminal launch hits it. See "Full bidirectional path" below.

### One-time install

1. Start a `claude` session anywhere and run these slash commands:

   ```
   /plugin marketplace add /path/to/claude-code-bridge
   /plugin install ccb@claude-code-bridge
   ```

   The first command points at the repo root (substitute your own checkout path) where `.claude-plugin/marketplace.json` lives. The second installs the `ccb` plugin from that marketplace.

   > **Marketplace rename caveat.** The marketplace registers under the `name` declared in `.claude-plugin/marketplace.json` (`claude-code-bridge`). If you installed under an older name (e.g. `ccb-local`), renaming the marketplace in the repo desyncs your local registration — `allowedChannelPlugins`, `enabledPlugins`, and `--channels plugin:ccb@<name>` will all still reference the stale name. Re-sync with `claude plugin marketplace remove <old-name>` then `claude plugin marketplace add <repo-path>` and `claude plugin install ccb@claude-code-bridge`, and update `allowedChannelPlugins` to the new name.

2. Tell `claude` it is allowed to expose the channel by adding `allowedChannelPlugins` to `~/.claude/settings.json`:

   ```json
   {
     "allowedChannelPlugins": [
       { "marketplace": "claude-code-bridge", "plugin": "ccb" }
     ]
   }
   ```

### Running with the plugin channel

Start `claude` from the repo root (so `${CLAUDE_PROJECT_DIR}` in the plugin manifest resolves to this workspace) with:

```bash
claude --channels plugin:ccb@claude-code-bridge \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

Expected outcome:

- No `--dangerously-load-development-channels` flag and no startup warning prompt about loading development channels.
- The channel server is spawned by `claude` from the plugin manifest's `mcpServers.ccb` entry, which runs the bare bin `ccb-channel-server` (requires a prior `bun add -g @pablospe/claude-code-bridge` to put it on PATH).
- The bridge (`scripts/smoke-manual.sh` in another terminal, `ccb serve` directly, or the managed-launch supervisor in the single-command path) still owns the control endpoint. The plugin manifest declares `CCB_BRIDGE_ENDPOINT` and `CCB_SESSION_ID` as env keys; the bridge populates them at session start by injecting overrides into the spawn.
- All other gating still applies: `tengu_harbor` must be enabled server-side and channels must be available to your account (see "Channels availability gate" below).
- **Outbound + hooks only.** Tool calls and `tool.event` records flow to the bridge, but inbound channel messages are rejected (`not on the approved channels allowlist`) — see the inbound caveat at the top of this section.

## Full bidirectional path (`--mcp-config` + dev flag)

This is the only path proven to round-trip inbound prompts **and** outbound replies, and it is exactly what `ccb serve` prints on startup. `ccb serve` writes a per-session `.mcp.json` (defining a plain `ccb` server with `CCB_BRIDGE_ENDPOINT` / `CCB_SESSION_ID` baked in) and prints the matching `claude` command:

```bash
# Terminal 1
ccb serve --session-id <uuid> --format pretty
#   → copy the printed command, e.g.:

# Terminal 2 (paste the printed command; --mcp-config path is per-session)
claude --dangerously-load-development-channels server:ccb \
  --mcp-config /tmp/ccb-serve-<uuid>.mcp.json \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

- The dev-channels **warning prompt is unavoidable** on this path (no flag suppresses it) — press `1` then Enter. `ccb-launcher` auto-confirms it for the headless variant.
- `--dangerously-load-development-channels server:ccb` needs a plain `ccb` server, which comes from `--mcp-config`. A plugin's server is namespaced (`mcp__plugin_ccb_ccb__*`) and does **not** satisfy `server:ccb` — which is why the plugin path can't do inbound.
- Use the `--mcp-config` path from the serve that is running **now**; serve removes the file on shutdown, so a stale path yields `server:ccb · no MCP server configured with that name`.

The plugin path (above) stays useful for outbound + hooks without the warning; the `--mcp-config` path is the one to use for a full inbound/outbound demo.

## Scripted variant (best-effort)

`scripts/smoke-scripted.ts` automates the same flow with one major caveat: `claude` requires a TTY at boot. The script is gated on `CCB_RUN_REAL_CLAUDE=1` and skips with a notice when the gate is not set. When the gate is set and `claude` refuses to boot under a piped stdio handle, the script logs `skipped: claude refused headless boot (needs a TTY)` and exits 0.

```bash
CCB_RUN_REAL_CLAUDE=1 bun scripts/smoke-scripted.ts
```

Do not depend on this in CI without a PTY surrogate. The intent is to give a single-command path for local experimentation; the supported single-command path for real `claude` is managed launch (`bun apps/ccb/src/cli.ts demo --supervisor=claude "..."`).

## External launcher (ccb-launcher)

`bin/ccb-launcher.cjs` (installed as the `ccb-launcher` bin) is a pure-Node companion that pairs with `ccb serve` to launch real `claude` without the bridge spawning it. It spawns `claude` with the exact arg set `ClaudeCodeSupervisor` would generate, auto-confirms the dev-channels warning the same way the supervisor does, and tees every PTY byte to a log file. Running under Node sidesteps Bun's NAPI gap (`node-pty`'s `onData` fires natively, no polyfill needed), so `claude` boots interactively and the channel server connects back to the bridge.

Managed launch (`ccb demo --supervisor=claude --channels=dev-flag`) now works on Bun-on-Linux too — a polling PTY polyfill in `@ccb/process` makes `onData` fire under Bun, and channel-ready gating keeps the first message from being delivered before claude is ready. See `docs/ARCHITECTURE.md` § "Choosing a supervisor" for the architectural framing.

Reach for the launcher when you want an explicit, inspectable `serve` + external-launch split (the tee'd PTY log is handy), or as a diagnostic if managed launch ever regresses to `supervisor.start timed out` or `agent.done reason=channel-disconnected`.

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

# 3. In a second terminal (real TTY required), launch ccb-launcher pointed at
#    the same bridge. NODE_PATH resolves @homebridge/node-pty-prebuilt-multiarch
#    from the workspace's isolated install layout when running from a source
#    checkout (a published install would put the dep at top-level node_modules
#    and NODE_PATH would be unnecessary).
NODE_PATH="$PWD/packages/process/node_modules" \
  node bin/ccb-launcher.cjs \
    --endpoint "$ENDPOINT" --session-id "$SESSION_ID"

# 4. Watch the bridge's JSONL event stream and the PTY trace log:
tail -f /tmp/ccb-verify-serve.log
tail -f /tmp/ccb-launcher.log
```

A successful run produces the canonical reply chain in the bridge log:

```jsonl
{"type":"session.started", ...}
{"type":"message.sent", ..., "content":"what is 11 squared?"}
{"type":"agent.reply", ..., "content":"11 squared is 121.", "final":true}
{"type":"agent.done", ...}
```

### Why the launcher exists

`ClaudeCodeSupervisor` reads claude's PTY via `node-pty`'s `onData` callback. Bun's NAPI layer didn't fire that callback for the PTY master fd (`oven-sh/bun#25822`); `@ccb/process` now installs a polling polyfill so managed launch works under Bun directly. `ccb-launcher` predates the polyfill and remains useful as an explicit `serve` + external-launch split: it spawns `claude` from a plain Node process (where `onData` is native, no polyfill), tees every PTY byte to a log, and keeps the launch fully inspectable. The bridge itself (the `ccb serve` half above) runs under Bun and exercises the production code path either way. See `docs/ARCHITECTURE.md` § "Choosing a supervisor" for the broader architectural story.

### CLI options

- `--endpoint <host:port>` — bridge control endpoint (default `127.0.0.1:18484`).
- `--session-id <uuid>` — required; must match the bridge's `--session-id`.
- `--log <path>` — PTY trace log file (default `/tmp/ccb-launcher.log`).
- `--mcp-config <path>` — override the temp `.mcp.json` path the launcher writes.
- `-h`, `--help` — show help and exit.

The launcher exits when `claude` exits. Ctrl-C tears down `claude` and removes the temp config.

### Common diagnoses

| symptom in `/tmp/ccb-launcher.log` | likely cause |
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

## Real-claude smoke with tool-call visibility (M3)

Drives a managed-launch turn through real `claude` with the hook relay registered, so `tool.event` records appear in the JSONL event stream alongside `agent.reply` / `agent.done`. After M3 a consumer sees what `claude` *did* (Bash commands, Read/Edit/Write calls, …), not just what it finally said. See `docs/M3.md` for the design.

The minimum hook set is three events: `PreToolUse`, `PostToolUse`, and `Stop`. The bridge fans every hook frame into a `BridgeEvent.tool.event` record; consumers pair Pre/Post by `payload.data.tool_use_id`.

### Programmatic (gated test)

The repo ships a `CCB_RUN_REAL_CLAUDE=1`-gated integration test that drives a deterministic prompt through real `claude` and asserts (a) at least one `tool.event` per minimum-set event, (b) Pre/Post pairing is in order by `tool_use_id`, and (c) the first `Stop` precedes the terminal event:

```bash
CCB_RUN_REAL_CLAUDE=1 bun test packages/claude-code/src/claude-supervisor.hooks.integration.test.ts
```

Without the env var the test prints a skip notice and passes, so the gate is the only thing standing between a fresh clone and a green run.

### Manual (unmanaged launch with `ccb hooks-config`)

For hosts that cannot run managed launch (`node-pty` unavailable, or you just want to see the bytes), `ccb hooks-config` emits the settings.json snippet that registers `ccb-hook-relay` for the three minimum events.

```bash
# 1. Pick a fixed endpoint + session id so all three pieces agree:
SESSION_ID=$(uuidgen)
ENDPOINT=127.0.0.1:18484

# 2. Write the hooks settings snippet to a per-session file:
HOOKS_SETTINGS=$(mktemp --suffix=.json)
bun apps/ccb/src/cli.ts hooks-config --out "$HOOKS_SETTINGS"

# 3. Write the .mcp.json the channel server consumes:
MCP_CONFIG=$(mktemp --suffix=.json)
bun apps/ccb/src/cli.ts mcp-config \
  --endpoint "$ENDPOINT" --session-id "$SESSION_ID" --out "$MCP_CONFIG"

# 4. In one terminal, host the bridge:
bun apps/ccb/src/cli.ts serve \
  --endpoint "$ENDPOINT" --session-id "$SESSION_ID" --format pretty

# 5. In a second terminal, export the env vars the relay reads, then launch
#    claude with both --mcp-config and --settings:
export CCB_BRIDGE_ENDPOINT="$ENDPOINT"
export CCB_SESSION_ID="$SESSION_ID"
claude --dangerously-load-development-channels server:ccb \
  --mcp-config "$MCP_CONFIG" \
  --settings "$HOOKS_SETTINGS" \
  --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"

# 6. Inside claude, ask: "Read README.md and report the first line".
#    The bridge's terminal should now interleave tool.event lines between
#    the agent.reply / agent.done lines.
```

`CCB_BRIDGE_ENDPOINT` and `CCB_SESSION_ID` are required: the relay bin (`bunx ccb-hook-relay`) reads both from its environment and tags every frame with the session id. Without them the bin logs `ccb-hook-relay: missing CCB_SESSION_ID` to stderr and exits 0 — claude's hook never blocks.

Expected event interleaving:

```
[session.started]  sid=…
[agent.reply]      "I'll take a look at README.md."
[tool.event]       PreToolUse Read "…/README.md"
[tool.event]       PostToolUse Read (1.2KB)
[agent.reply]      "The first line is `# Claude Code Bridge`."
[tool.event]       Stop        (per-message)
[agent.done]       final=true
[session.ended]    reason="agent done"
```

The managed-launch path (`bun apps/ccb/src/cli.ts demo --supervisor=claude`) does not yet expose a `--hooks` flag from the CLI; the supervisor option is wired (`hooks: { events: [...] }`) and is what the gated integration test above exercises.

## Real install from npm (M4)

Validates the publish artifact end-to-end against real `claude`. The M4
plugin manifest invokes bare bin names (`ccb-channel-server`,
`ccb-hook-relay`) and relies on a prior `bun add -g @pablospe/claude-code-bridge`
to put them on PATH. These smokes prove that contract.

### Manual: install from a packed tarball

```bash
bun run build && bun pm pack
# produces pablospe-claude-code-bridge-0.1.0.tgz in the repo root

mkdir -p /tmp/ccb-install-smoke && cd /tmp/ccb-install-smoke
bun init -y
bun add /path/to/pablospe-claude-code-bridge-0.1.0.tgz
export PATH="$PWD/node_modules/.bin:$PATH"

ccb-channel-server --help    # sanity check: bundled bin loads
ccb-hook-relay --help        # sanity check: bundled bin loads
ccb --help                   # sanity check: CLI loads
```

Then in a separate scratch directory point a fresh `claude` session at
the local marketplace and install the plugin:

```text
/plugin marketplace add /path/to/claude-code-bridge
/plugin install ccb@claude-code-bridge
```

Start `claude` with a bridge already running on the loopback endpoint
the plugin's `mcpServers.ccb` env wires through, send a deterministic
prompt (e.g. "what is 11 squared?"), and watch the bridge's event stream
for `tool.event` records interleaved with `agent.reply` / `agent.done`.

### Programmatic: gated end-to-end test

```bash
CCB_RUN_PLUGIN_SMOKE=1 bun test packages/claude-code/src/claude-supervisor.plugin-install.integration.test.ts
```

The gated test (delivered by M4.5) builds the tarball, installs it into
a temp dir so `ccb-channel-server` and `ccb-hook-relay` land in
`<tmp>/node_modules/.bin/`, prepends that `.bin` to `PATH`, points
claude's plugin marketplace at the local repo, runs the M3.7
deterministic prompt through real `claude`, and asserts the same
coverage and Pre/Post ordering guarantees as the M3.7 hooks-integration
test — but exercising the **public install path** rather than the
managed-launch `hooks:` option. Without the env var the test prints a
skip notice and passes.

Run this gated test once before every `bun publish` of a new tarball.
It is the only place we prove the published artifact + plugin manifest
deliver `tool.event` records to the bridge as a unit.

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

## OpenAI facade (`ccb api`)

All smokes assume a logged-in `claude` >= 2.1.169 on PATH. Start the server
in one terminal and leave it running:

```bash
bun apps/ccb/src/cli.ts api --supervisor claude --pool-size 1
```

### Smoke 1 — clean boot

Decision gate RESOLVED (claude 2.1.170): cleanSession is the user-tier
exclusion (`--strict-mcp-config` + `--setting-sources project,local`, which
also drops user-enabled plugins and hooks) WITHOUT `--disable-slash-commands`,
so clear() can still inject /clear. Two candidates were rejected: `--safe-mode`
severs the `--mcp-config` channel (startSession times out), and
`CLAUDE_CONFIG_DIR` breaks the channels-to-MCP binding (claude replies in the
TUI instead of bridge_reply). The pool session boots with the ccb channel
connected; watch the server terminal for the listening line, then the request
below succeeds.

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"Reply with exactly the word: pong"}]}' | jq .
```

Expected: choices[0].message.content contains "pong". The session must show
no operator customizations (no claude-mem observations, no plugin hooks in
the reply context).

### Smoke 2 — /clear isolation between requests

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"Remember this codeword: ZANZIBAR. Reply OK."}]}' | jq -r '.choices[0].message.content'

curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"What codeword did I give you earlier? If none, say NONE."}]}' | jq -r '.choices[0].message.content'
```

Expected: second reply says NONE (the /clear between turns wiped the first
request's context). If it answers ZANZIBAR, /clear injection is broken.

### Smoke 3 — tool-calling round trip

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "ccb-claude",
    "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
    "tools": [{"type": "function", "function": {"name": "get_weather",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
  }' | jq '.choices[0]'
```

Expected: finish_reason "tool_calls" and a get_weather call with city Paris.
Then complete the round trip (substitute the printed tool_call id):

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "ccb-claude",
    "messages": [
      {"role": "user", "content": "What is the weather in Paris? Use the tool."},
      {"role": "assistant", "content": null, "tool_calls": [{"id": "<ID>", "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]},
      {"role": "tool", "tool_call_id": "<ID>", "content": "{\"temp_c\": 18, \"sky\": \"sunny\"}"}
    ]
  }' | jq -r '.choices[0].message.content'
```

Expected: a sentence reporting ~18°C / sunny, finish_reason "stop".

### Smoke 4 — litellm end to end (non-streaming + streaming)

```bash
uv run --with litellm scripts/litellm-smoke.py
```

Expected: prints both replies and `OK`, exit 0.

### Smoke 5 — structured output via Instructor (forced tool_choice)

```bash
uv run --with instructor --with openai scripts/instructor-smoke.py
```

Expected: prints `extracted: name='John Doe' age=30` and `OK`, exit 0. This
exercises the `tool_choice` forced-function path: Instructor's default TOOLS
mode sends the Pydantic schema as a tool with a forced tool_choice; the facade
renders the MUST-call instruction and the reply parses into `tool_calls`.

### Smoke 6 — Anthropic dialect via the official SDK

```bash
uv run --with anthropic scripts/anthropic-smoke.py
```

Expected output (three sections then `OK`, exit 0):

```
non-streaming reply: 'pong' stop_reason=end_turn
streamed reply: 'pong' stop_reason=end_turn
tool call: get_weather({'city': 'Paris'})
final answer: '...18...'
OK
```

This drives the facade's `POST /v1/messages` endpoint: non-streaming, the
`messages.stream` SSE path, and a `tool_use` / `tool_result` round trip with a
forced `tool_choice`. Setting `ANTHROPIC_BASE_URL=http://127.0.0.1:18485`
redirects ANY anthropic-SDK tool to the facade with zero code changes.
litellm's anthropic provider (`model="anthropic/ccb-claude",
api_base="http://127.0.0.1:18485"`) also routes here.

### Smoke 7 — tool-enabled api (`--allow-tools`)

This exercises the M5 permission relay through the facade: with `--allow-tools`,
claude's built-in tools are enabled, the allowlist is pre-approved (no prompt),
and anything else that prompts is auto-denied by the policy and degrades to text
instead of erroring. Sessions act on the directory where `ccb api` was started,
so the server **must** be launched from the repo root (where `README.md` lives).

Terminal 1 — start the server with Read + Bash pre-approved:

```bash
bun apps/ccb/src/cli.ts api --allow-tools Read,Bash
#   ccb api listening on http://127.0.0.1:18485/v1
```

Terminal 2 — run the smoke:

```bash
uv run --with openai scripts/tools-smoke.py
```

Expected output (two steps then `SMOKE OK`, exit 0):

```
[1/2] allowed tool (Read README.md)...
  finish_reason=stop reply='The first heading in README.md says: "# Claude Code Bridge"'
[2/2] denied tool (Write a file)...
  finish_reason=stop reply='DENIED'
SMOKE OK
```

Step 1 asks claude to use its **allowed** Read tool to read `README.md` and
report the first heading (asserts the reply carries repo-identifying content).
Step 2 asks it to use its **denied** Write tool to create a file; the policy
auto-denies, the turn degrades to text, and no file is created.

What to verify in `.ccb-data/<session>.jsonl`:

- The allowed Read does **not** surface a `permission.requested` — pre-approved
  tools run silently inside claude (the reply with the heading is the evidence).
- The denied Write surfaces a `permission.requested` (`toolName:"Write"`)
  immediately followed by a `permission.resolved` with `outcome:"deny"`, e.g.:

  ```json
  {"type":"permission.requested","toolName":"Write","inputPreview":"{\"file_path\":\".../ccb-smoke-should-not-exist.txt\",...}"}
  {"type":"permission.resolved","requestId":"...","outcome":"deny"}
  ```

- `ccb-smoke-should-not-exist.txt` is **not** created in the cwd.

Live-run result: passed full-stack against real `claude` 2.1.175 on
2026-06-13 — the Read returned `# Claude Code Bridge`, the Write produced a
`permission.requested(Write)` → `permission.resolved(outcome:"deny")` pair and
degraded to `DENIED` text with `finish_reason=stop`, and no stray file was
written. The underlying permission-relay protocol was first proven by
`scripts/spike-permission`; see
[`docs/2026-06-12-spike-findings.md`](./2026-06-12-spike-findings.md).
