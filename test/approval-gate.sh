#!/usr/bin/env bash
# End-to-end check of the approval gate against a live server.
# Simulates exactly the bypass: a client key calling /api/publish directly.
set -u
B="http://localhost:$PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected: $3"; echo "        actual:   $2"; fail=$((fail+1)); fi; }

j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }

HTML='<html><head><title>T</title></head><body><main><h1>Original Headline</h1><p>Body copy here.</p></main></body></html>'

echo "── setup ──"
j "$B/api/ingest?key=$OK" "$(printf '{"name":"acme","html":%s}' "$(printf '%s' "$HTML" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" > /dev/null
# publish once as owner so a live release exists
j "$B/api/publish?key=$OK&site=acme" '{"pages":{}}' > /dev/null
# hand off with a password + approval REQUIRED
j "$B/api/admin/set-password?key=$OK" '{"site":"acme","password":"clientpw123","requireApproval":true}' > /dev/null
echo "  site ingested, handed off, requireApproval=true"

CK="clientpw123"
FIELD=$(curl -s "$B/api/state?site=acme&key=$OK" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for g in (d.get("groups") or {}).values():
    for f in g:
        if not f.get("rich") and not str(f.get("id","")).startswith("seo:"):
            print(f["id"]); sys.exit()
print("")
' 2>/dev/null)
echo "  editing field: $FIELD"

echo
echo "── the bypass: client calls /api/publish directly ──"
RES=$(j "$B/api/publish?site=acme&key=$CK" "$(printf '{"pages":{"home":{"%s":"HACKED HEADLINE"}}}' "$FIELD")")
echo "  response: $RES"
GOTLIVE=$(printf '%s' "$RES" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("yes" if d.get("ok") and not d.get("pendingReview") else "no")' 2>/dev/null || echo "?")
chk "client publish does NOT go live" "$GOTLIVE" "no"
PEND=$(printf '%s' "$RES" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("pendingReview",False))' 2>/dev/null)
chk "response flags pendingReview" "$PEND" "True"

echo
echo "── the edit must be queued, not discarded ──"
RV=$(curl -s "$B/api/review?site=acme" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("pending",False))')
chk "review is pending" "$RV" "True"

echo
echo "── the live release must still show the original ──"
LIVE=$(curl -s "$B/live/acme")
if printf '%s' "$LIVE" | grep -q "HACKED HEADLINE"; then LEAK="leaked"; else LEAK="clean"; fi
chk "live site does NOT contain the unapproved edit" "$LEAK" "clean"

echo
echo "── owner approval still works and DOES go live ──"
AP=$(j "$B/api/review/approve?key=$OK&site=acme" '{}')
OKAP=$(printf '%s' "$AP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ok",False))')
chk "owner approve succeeds" "$OKAP" "True"
LIVE2=$(curl -s "$B/live/acme")
if printf '%s' "$LIVE2" | grep -q "HACKED HEADLINE"; then SEEN="present"; else SEEN="missing"; fi
chk "approved edit IS now live" "$SEEN" "present"

echo
echo "── control: with approval OFF, a client can publish directly ──"
j "$B/api/admin/approval?key=$OK" '{"site":"acme","requireApproval":false}' > /dev/null
RES2=$(j "$B/api/publish?site=acme&key=$CK" "$(printf '{"pages":{"home":{"%s":"CLIENT SELF SERVE"}}}' "$FIELD")")
DIRECT=$(printf '%s' "$RES2" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("yes" if d.get("ok") and not d.get("pendingReview") else "no")' 2>/dev/null)
chk "ungated client publishes straight to live" "$DIRECT" "yes"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
