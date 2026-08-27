#!/usr/bin/env bash
# Boots the CMS on a scratch port against throwaway data, runs the suites, then
# tears everything down. No external services needed.
#
#   npm test                 both suites
#   npm test approval-gate   just one
set -u
cd "$(dirname "$0")/.."

export PORT="${PORT:-4477}"
export FIXTURE_PORT="${FIXTURE_PORT:-4600}"
export ADMIN_KEY="${ADMIN_KEY:-test-owner-key}"
LOG=$(mktemp)
FIXLOG=$(mktemp)

scrub(){ rm -rf sites/acme sites/tmp1 sites/tmp2 sites/tmp3 sites/x sites/multi sites/mixed team dist; }
cleanup(){
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  [ -n "${FIX:-}" ] && kill "$FIX" 2>/dev/null
  scrub; rm -f "$LOG" "$FIXLOG"
}
trap cleanup EXIT

scrub
node server.mjs > "$LOG" 2>&1 &
SRV=$!
node test/fixture-site.mjs "$FIXTURE_PORT" > "$FIXLOG" 2>&1 &
FIX=$!

for _ in $(seq 1 40); do
  curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -s "http://localhost:$PORT/api/state?site=none" >/dev/null 2>&1; then
  echo "server failed to start on :$PORT"; cat "$LOG"; exit 1
fi
for _ in $(seq 1 40); do
  curl -s "http://localhost:$FIXTURE_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -s "http://localhost:$FIXTURE_PORT/" >/dev/null 2>&1; then
  echo "fixture site failed to start on :$FIXTURE_PORT"; cat "$FIXLOG"; exit 1
fi

rc=0
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(mirror-order boot-resilience approval-gate team-roles team-console multipage-ingest)
for suite in "${suites[@]}"; do
  echo; echo "############ $suite ############"
  if [ -f "test/$suite.mjs" ]; then node "test/$suite.mjs" || rc=1
  else bash "test/$suite.sh" || rc=1; fi
done
exit $rc
