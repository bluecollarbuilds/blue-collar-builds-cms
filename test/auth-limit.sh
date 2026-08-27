#!/usr/bin/env bash
# Brute-force braking. Client passwords can be short, so unlimited guessing was
# an open door. Boots its own server with a tiny limit so the trip wire is
# reachable in a test, then verifies: failures below the limit pass through,
# crossing it locks the IP (valid keys included — that lockout is the brake),
# and keyless requests are never counted or blocked.
set -u
cd "$(dirname "$0")/.."
P="${LIMIT_PORT:-4587}"
K="limit-owner-key"
B="http://localhost:$P"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
gc(){ curl -s -o /dev/null -w '%{http_code}' "$1"; }

LOG=$(mktemp)
cleanup(){ [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT

PORT=$P ADMIN_KEY=$K CMS_AUTH_RATE_LIMIT=5 CMS_ALLOW_PRIVATE_FETCH=1 node server.mjs > "$LOG" 2>&1 &
SRV=$!
up=no
for _ in $(seq 1 40); do curl -s "$B/api/me" >/dev/null 2>&1 && { up=yes; break; }; sleep 0.25; done
[ "$up" = yes ] || { echo "server failed to start"; cat "$LOG"; exit 1; }

echo "── below the limit, wrong keys just fail normally ──"
for i in 1 2 3 4; do gc "$B/api/me?key=wrong-$i" > /dev/null; done
chk "4 failures recorded, still serving" "$(gc "$B/api/me?key=wrong-5")" "200"

echo
echo "── crossing the limit locks the address ──"
chk "6th bad key is refused with 429"  "$(gc "$B/api/me?key=wrong-6")" "429"
chk "even the VALID owner key is 429"  "$(gc "$B/api/me?key=$K")" "429"
chk "admin routes refuse too"          "$(gc "$B/api/admin/team?key=$K")" "429"

echo
echo "── keyless requests are never brute-force attempts ──"
chk "keyless /api/me still 200"        "$(gc "$B/api/me")" "200"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
