#!/usr/bin/env bash
# Verifies the role matrix over real HTTP — each role against each guarded route,
# plus revocation and the ADMIN_KEY break-glass path.
set -u
B="http://localhost:$PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }

j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
# HTTP status for a POST
code(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "${2:-\{\}}"; }
gcode(){ curl -s -o /dev/null -w '%{http_code}' "$1"; }

echo "── provisioning members via the owner key ──"
ADMIN_J=$(j "$B/api/admin/team/add?key=$OK" '{"name":"Pat PM","role":"admin","email":"pm@example.com"}')
EDITOR_J=$(j "$B/api/admin/team/add?key=$OK" '{"name":"Dev Devine","role":"editor"}')
AK=$(printf '%s' "$ADMIN_J"  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key",""))')
EK=$(printf '%s' "$EDITOR_J" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key",""))')
EID=$(printf '%s' "$EDITOR_J"| python3 -c 'import json,sys;print(json.load(sys.stdin).get("member",{}).get("id",""))')
[ -n "$AK" ] && [ -n "$EK" ] && echo "  admin + editor created" || { echo "  could not provision members"; echo "$ADMIN_J"; echo "$EDITOR_J"; exit 1; }

echo
echo "── the key is never readable afterwards ──"
LIST=$(curl -s "$B/api/admin/team?key=$OK")
if printf '%s' "$LIST" | grep -q "keyHash"; then LEAK=leak; else LEAK=clean; fi
chk "team listing does not expose keyHash" "$LEAK" "clean"

echo
echo "── setup: a site to act on ──"
HTML='<html><head><title>T</title></head><body><main><h1>Headline</h1></main></body></html>'
j "$B/api/ingest?key=$OK" "$(printf '{"name":"acme","html":%s}' "$(printf '%s' "$HTML" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" > /dev/null
j "$B/api/publish?key=$OK&site=acme" '{"pages":{}}' > /dev/null
echo "  site acme ready"

echo
echo "── editor (developer) ──"
chk "can ingest"                 "$(code "$B/api/ingest?key=$EK" '{"name":"tmp1","html":"<html><body><main><h1>x</h1></main></body></html>"}')" "200"
chk "can approve/reject"         "$(code "$B/api/review/reject?key=$EK&site=acme" '{}')" "200"
chk "can export"                 "$(code "$B/api/admin/export?key=$EK" '{"site":"acme"}')" "200"
chk "CANNOT issue client links"  "$(code "$B/api/admin/handoff?key=$EK" '{"site":"acme"}')" "401"
chk "CANNOT set client password" "$(code "$B/api/admin/set-password?key=$EK" '{"site":"acme","password":"x1234567"}')" "401"
chk "CANNOT link Vercel project" "$(code "$B/api/admin/site-vercel?key=$EK" '{"site":"acme","project":"p"}')" "401"
chk "CANNOT read Vercel config"  "$(gcode "$B/api/admin/config?key=$EK")" "401"
chk "CANNOT manage team"         "$(code "$B/api/admin/team/add?key=$EK" '{"name":"X","role":"owner"}')" "401"
chk "CANNOT see cross-site feed" "$(gcode "$B/api/activity?key=$EK")" "401"

echo
echo "── admin (project manager) ──"
chk "can issue client links"     "$(code "$B/api/admin/handoff?key=$AK" '{"site":"acme"}')" "200"
chk "can link Vercel project"    "$(code "$B/api/admin/site-vercel?key=$AK" '{"site":"acme","project":"p"}')" "200"
chk "can toggle approval"        "$(code "$B/api/admin/approval?key=$AK" '{"site":"acme","requireApproval":true}')" "200"
chk "can see cross-site feed"    "$(gcode "$B/api/activity?key=$AK")" "200"
chk "CANNOT read Vercel config"  "$(gcode "$B/api/admin/config?key=$AK")" "401"
chk "CANNOT manage team"         "$(code "$B/api/admin/team/add?key=$AK" '{"name":"X","role":"owner"}')" "401"

echo
echo "── owner ──"
chk "can read Vercel config"     "$(gcode "$B/api/admin/config?key=$OK")" "200"
chk "can manage team"            "$(gcode "$B/api/admin/team?key=$OK")" "200"

echo
echo "── staff are not treated as gated clients ──"
# acme now requires approval; a team member must still publish straight through.
PUB=$(j "$B/api/publish?site=acme&key=$EK" '{"pages":{}}')
GATED=$(printf '%s' "$PUB" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("pendingReview",False))' 2>/dev/null || echo "?")
chk "editor publish is not queued for review" "$GATED" "False"
ME=$(curl -s "$B/api/me?site=acme&key=$EK")
chk "editor reports staff=true" "$(printf '%s' "$ME" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("staff",False))')" "True"

echo
echo "── revocation takes effect immediately ──"
j "$B/api/admin/team/revoke?key=$OK" "$(printf '{"id":"%s"}' "$EID")" > /dev/null
chk "revoked editor is refused"  "$(code "$B/api/ingest?key=$EK" '{"name":"tmp2","html":"<html><body><main><h1>x</h1></main></body></html>"}')" "401"

echo
echo "── unknown keys get nothing ──"
chk "garbage key refused"        "$(code "$B/api/ingest?key=not-a-real-key" '{"name":"tmp3","html":"<html><body><main><h1>x</h1></main></body></html>"}')" "401"

echo
echo "── audit records the person, not just a role ──"
AUD=$(curl -s "$B/api/audit?site=acme&key=$AK")
NAMED=$(printf '%s' "$AUD" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("yes" if any((e.get("actor") or {}).get("name") for e in d.get("entries",[])) else "no")')
chk "entries carry an actor name" "$NAMED" "yes"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
