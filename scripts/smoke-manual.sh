#!/usr/bin/env bash
set -euo pipefail

# scripts/smoke-manual.sh - prepare and host a manual real-claude smoke session.
#
# This script writes a per-session .mcp.json, prints the exact claude command
# the human should run in a second terminal, and then runs `ccb serve` in the
# foreground. Press Ctrl-C to tear down the bridge.
#
# Override the bound port via CCB_SMOKE_PORT (default: 18484).
# Override the bind host via CCB_SMOKE_HOST (default: 127.0.0.1).
# Override the store directory via CCB_SMOKE_STORE_DIR (default: .ccb-data).

usage() {
  cat <<EOF
Usage: $0 [--help]

Hosts a Claude Code Bridge control endpoint and walks through the manual
real-claude smoke procedure. No arguments are required.

Environment overrides:
  CCB_SMOKE_PORT       TCP port to bind on loopback   (default 18484)
  CCB_SMOKE_HOST       host to bind                   (default 127.0.0.1)
  CCB_SMOKE_STORE_DIR  per-session JSONL output dir   (default .ccb-data)

Prerequisites:
  - claude CLI v2.1.80 or newer
  - bun on PATH
  - Channels are a research-preview feature; claude must be started with
    --dangerously-load-development-channels server:ccb
EOF
}

case "${1:-}" in
  -h | --help | help)
    usage
    exit 0
    ;;
esac

CCB_SMOKE_HOST="${CCB_SMOKE_HOST:-127.0.0.1}"
CCB_SMOKE_PORT="${CCB_SMOKE_PORT:-18484}"
CCB_SMOKE_STORE_DIR="${CCB_SMOKE_STORE_DIR:-.ccb-data}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="$REPO_ROOT/apps/ccb/src/cli.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not on PATH" >&2
  exit 1
fi

SESSION_ID="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
MCP_CONFIG_PATH="/tmp/ccb-smoke-${SESSION_ID}.mcp.json"
ENDPOINT="${CCB_SMOKE_HOST}:${CCB_SMOKE_PORT}"
BUN_BIN="$(command -v bun)"
CHANNEL_BIN="$REPO_ROOT/packages/mcp-channel/src/bin.ts"

# Write the .mcp.json with absolute paths to the bun runtime and the channel
# server entry. The CLI's `ccb mcp-config` defaults to `bunx ccb-channel-server`
# which only resolves if the package is published; for the workspace-local
# smoke we want claude to spawn this monorepo's bin directly.
cat >"$MCP_CONFIG_PATH" <<JSON
{
  "mcpServers": {
    "ccb": {
      "command": "$BUN_BIN",
      "args": ["$CHANNEL_BIN"],
      "env": {
        "CCB_BRIDGE_ENDPOINT": "$ENDPOINT",
        "CCB_SESSION_ID": "$SESSION_ID"
      }
    }
  }
}
JSON

cat <<EOF
ccb manual smoke
================
session_id        : $SESSION_ID
control endpoint  : $ENDPOINT
mcp config        : $MCP_CONFIG_PATH
store dir         : $CCB_SMOKE_STORE_DIR

In a second terminal run:

  claude --dangerously-load-development-channels server:ccb --mcp-config $MCP_CONFIG_PATH

Tip: append --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
to that command to skip the per-tool permission prompt for the bridge's three
MCP tools only (other permission checks stay gated). The full command becomes:

  claude --dangerously-load-development-channels server:ccb \\
    --mcp-config $MCP_CONFIG_PATH \\
    --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"

Then in this terminal, type a line of text and press enter — the bridge will
forward it to claude as a notifications/claude/channel envelope. Watch this
terminal for the live event stream. Press Ctrl-C to stop.

EOF

exec bun "$CLI_PATH" serve \
  --endpoint "$ENDPOINT" \
  --session-id "$SESSION_ID" \
  --store-dir "$CCB_SMOKE_STORE_DIR" \
  --format pretty
