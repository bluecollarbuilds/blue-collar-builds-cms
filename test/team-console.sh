#!/usr/bin/env bash
# Exercises the /api/admin/team* routes exactly as the console panel calls them,
# plus /api/me role gating that the panel uses to show/hide owner-only cards.
set -u
B="http://localhost:$PORT"
OK="$ADMIN_KEY"
AID=""   # set once the member is created; referenced by pyv() before then in one check
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
gj(){ curl -s -H "x-edit-key: $2" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "${2:-\{\}}"; }
# Reads a python expression from a file to dodge bash's mangling of escaped
# quotes inside a -c string — an id gets interpolated as a $var, not literal.
pyv(){ AID="$AID" python3 -c "
import json, sys, os
d = json.load(sys.stdin)
aid = os.environ.get('AID','')
print($1)
"; }

echo "── /api/me gates the owner-only cards ──"
ME_OWNER=$(gj "$B/api/me" "$OK")
chk "owner key -> role owner" "$(printf '%s' "$ME_OWNER" | pyv 'd["role"]')" "owner"

echo
echo "── add via the console's exact call shape ──"
ADD=$(j "$B/api/admin/team/add?key=$OK" '{"name":"Priya PM","email":"priya@example.com","role":"admin"}')
chk "add responds ok"        "$(printf '%s' "$ADD" | pyv 'd.get("ok")')" "True"
AKEY=$(printf '%s' "$ADD" | pyv 'd["key"]')
AID=$(printf '%s' "$ADD" | pyv 'd["member"]["id"]')
[ -n "$AKEY" ] && [ -n "$AID" ] && echo "  key + id present" || { echo "  missing key/id"; exit 1; }

ME_ADMIN=$(gj "$B/api/me" "$AKEY")
chk "new admin key -> role admin" "$(printf '%s' "$ME_ADMIN" | pyv 'd["role"]')" "admin"
chk "admin actor name matches"    "$(printf '%s' "$ME_ADMIN" | pyv 'd["actor"]["name"]')" "Priya PM"

echo
echo "── listing never exposes the hash, only public fields ──"
LIST=$(gj "$B/api/admin/team" "$OK")
chk "listing includes the new member" "$(printf '%s' "$LIST" | pyv 'any(m["id"]==aid for m in d["members"])')" "True"
if printf '%s' "$LIST" | grep -q "keyHash"; then LEAK=leak; else LEAK=clean; fi
chk "no keyHash in the response" "$LEAK" "clean"

echo
echo "── an admin key cannot reach the team panel's own data source ──"
chk "admin GET /api/admin/team refused" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/admin/team?key=$AKEY")" "401"

echo
echo "── role dropdown -> POST /api/admin/team/role ──"
ROLE=$(j "$B/api/admin/team/role?key=$OK" "$(printf '{"id":"%s","role":"editor"}' "$AID")")
chk "role change ok" "$(printf '%s' "$ROLE" | pyv 'd.get("ok")')" "True"
ME_AFTER=$(gj "$B/api/me" "$AKEY")
chk "same key now resolves editor" "$(printf '%s' "$ME_AFTER" | pyv 'd["role"]')" "editor"

echo
HTML='{"name":"x","html":"<html><body><main><h1>x</h1></main></body></html>"}'

echo "── rotate -> old key dead, new key live ──"
ROT=$(j "$B/api/admin/team/rotate?key=$OK" "$(printf '{"id":"%s"}' "$AID")")
NEWKEY=$(printf '%s' "$ROT" | pyv 'd["key"]')
chk "old key now refused on a guarded route" "$(code "$B/api/ingest?key=$AKEY" "$HTML")" "401"
chk "old key's identity is none"             "$(gj "$B/api/me" "$AKEY" | pyv 'd["role"]')" "none"
chk "new key works on a guarded route"       "$(code "$B/api/ingest?key=$NEWKEY" "$HTML")" "200"

echo
echo "── revoke -> reissue flow the panel offers on a revoked row ──"
j "$B/api/admin/team/revoke?key=$OK" "$(printf '{"id":"%s"}' "$AID")" > /dev/null
chk "revoked key refused on a guarded route" "$(code "$B/api/ingest?key=$NEWKEY" "$HTML")" "401"
chk "revoked key's identity is none"         "$(gj "$B/api/me" "$NEWKEY" | pyv 'd["role"]')" "none"
LIST2=$(gj "$B/api/admin/team" "$OK")
chk "listing shows revokedAt set" "$(printf '%s' "$LIST2" | pyv 'next(m["revokedAt"] is not None for m in d["members"] if m["id"]==aid)')" "True"
REISSUE=$(j "$B/api/admin/team/rotate?key=$OK" "$(printf '{"id":"%s"}' "$AID")")
chk "reissue clears revocation" "$(printf '%s' "$REISSUE" | pyv 'd["member"]["revokedAt"] is None')" "True"

echo
echo "── unknown key ──"
chk "garbage key -> role none" "$(gj "$B/api/me" "not-a-key" | pyv 'd["role"]')" "none"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
