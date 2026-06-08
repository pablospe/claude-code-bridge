#!/usr/bin/env bash
# L6 smoke: load the claude-bridge plugin into an ISOLATED OpenClaw gateway and
# route a real turn through it. Touches NOTHING of the live podman gateway —
# it runs a separate gateway process pointed at throwaway home/state dirs.
#
# Prereq (the one gated step): the openclaw checkout must be built. The first
# `pnpm openclaw` triggers a heavy build AND a pnpm deps reconcile on your main
# checkout. Run that yourself first if you want control:
#     cd ~/code/openclaw && CI=true pnpm build      # heavy; reconciles deps
#
# Usage: bash run-l6-smoke.sh
set -euo pipefail

OC=~/code/openclaw
TEST=~/oc-bridge-test
export OPENCLAW_HOME="$TEST/home"
export OPENCLAW_STATE_DIR="$TEST/state"
export OPENCLAW_CONFIG_PATH="$TEST/state/openclaw.json"

mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR"
cp "$(dirname "$0")/openclaw.json" "$OPENCLAW_CONFIG_PATH"
echo "[l6] isolated state: $OPENCLAW_STATE_DIR (live ~/.openclaw untouched)"

cd "$OC"

echo "[l6] starting isolated gateway (first run auto-builds; this is the heavy/gated step)..."
CI=true pnpm openclaw gateway run >"$TEST/gateway.log" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null || true' EXIT

echo "[l6] waiting for gateway to come up (tail $TEST/gateway.log)..."
for i in $(seq 1 180); do
  if grep -qiE "gateway (ready|listening|started)" "$TEST/gateway.log" 2>/dev/null; then break; fi
  sleep 2
done
tail -5 "$TEST/gateway.log" || true

echo "[l6] verifying the claude-bridge backend registered..."
CI=true pnpm openclaw plugins inspect claude-bridge --runtime --json || true

echo "[l6] sending a real turn through the gateway -> claude-bridge -> interactive claude..."
CI=true pnpm openclaw agent --agent main --session-id l6-smoke-1 \
  --message "What is 11 squared? Reply with only the number." --json --timeout 180

echo "[l6] done. If the reply contains 121, the full stack works: OpenClaw -> ACP -> ccb -> real claude (Max)."
