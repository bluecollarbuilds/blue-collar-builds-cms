#!/usr/bin/env bash
# Boots the CMS on a scratch port against a throwaway site, runs the approval-gate
# checks, then tears everything down. No external services needed.
#
#   npm run test:approval
set -u
cd "$(dirname "$0")/.."

export PORT="${PORT:-4477}"
export ADMIN_KEY="${ADMIN_KEY:-test-owner-key}"
LOG=$(mktemp)

cleanup(){ [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf sites/acme; rm -f "$LOG"; }
trap cleanup EXIT

rm -rf sites/acme
node server.mjs > "$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1; then
  echo "server failed to start on :$PORT"; cat "$LOG"; exit 1
fi

bash test/approval-gate.sh
