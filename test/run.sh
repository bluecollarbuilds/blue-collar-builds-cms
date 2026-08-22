#!/usr/bin/env bash
# Boots the CMS on a scratch port against throwaway data, runs the suites, then
# tears everything down. No external services needed.
#
#   npm test                 both suites
#   npm test approval-gate   just one
set -u
cd "$(dirname "$0")/.."

export PORT="${PORT:-4477}"
export ADMIN_KEY="${ADMIN_KEY:-test-owner-key}"
LOG=$(mktemp)

scrub(){ rm -rf sites/acme sites/tmp1 sites/tmp2 sites/tmp3 sites/x team dist; }
cleanup(){ [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; scrub; rm -f "$LOG"; }
trap cleanup EXIT

scrub
node server.mjs > "$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1; then
  echo "server failed to start on :$PORT"; cat "$LOG"; exit 1
fi

rc=0
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(approval-gate team-roles team-console)
for suite in "${suites[@]}"; do
  echo; echo "############ $suite ############"
  bash "test/$suite.sh" || rc=1
done
exit $rc
