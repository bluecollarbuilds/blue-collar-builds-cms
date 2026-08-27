#!/usr/bin/env bash
# Reproduces the production crash loop: a site whose site.json survived but whose
# page files did not. That combination took the entire CMS down on every boot,
# so one damaged site made every other client's editor unreachable.
#
# Runs its own server on a separate port against a hand-made broken site.
set -u
cd "$(dirname "$0")/.."
P="${BOOT_PORT:-4585}"
K="boot-test-key"
B="http://localhost:$P"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
py(){ python3 -c "
import json,sys
d=json.load(sys.stdin)
print($1)
"; }

BOOTLOG=$(mktemp)
cleanup(){ [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf sites/wrecked sites/healthy; rm -f "$BOOTLOG"; }
trap cleanup EXIT
rm -rf sites/wrecked sites/healthy

echo "── build one healthy site and one wrecked site ──"
# healthy: a complete site
mkdir -p sites/healthy/pages/home
printf '<html><head><title>Fine</title></head><body><main><h1 data-cms="a">Fine</h1></main></body></html>' > sites/healthy/pages/home/template.html
echo '{"a":"Fine"}' > sites/healthy/pages/home/content.json
echo '{"a":{"label":"H","group":"Content","type":"text"}}' > sites/healthy/pages/home/schema.json
echo '{"sections":[],"collections":[]}' > sites/healthy/pages/home/meta.json
echo '{"order":["home"],"home":"home","pages":{"home":{"title":"Fine","path":"/"}}}' > sites/healthy/site.json

# wrecked: site.json claims a home page whose files are absent — exactly the
# state the mirror race left in the database.
mkdir -p sites/wrecked
echo '{"order":["home"],"home":"home","pages":{"home":{"title":"Gone","path":"/"}}}' > sites/wrecked/site.json
echo "  sites/wrecked has site.json but no pages/home/*"

echo
echo "── the server must still start ──"
PORT=$P ADMIN_KEY=$K node server.mjs > "$BOOTLOG" 2>&1 &
SRV=$!
up=no
for _ in $(seq 1 40); do
  if curl -s "$B/api/sites" >/dev/null 2>&1; then up=yes; break; fi
  sleep 0.25
done
chk "server booted despite the wrecked site" "$up" "yes"
if [ "$up" != "yes" ]; then echo "--- boot log ---"; cat "$BOOTLOG"; echo "════ $pass passed, $((fail+1)) failed ════"; exit 1; fi

echo
echo "── the healthy site is unaffected ──"
S=$(curl -s "$B/api/sites")
chk "healthy site loaded"        "$(printf '%s' "$S" | py '"yes" if any(x["name"]=="healthy" for x in d["sites"]) else "no"')" "yes"
chk "wrecked site not served"    "$(printf '%s' "$S" | py '"yes" if not any(x["name"]=="wrecked" for x in d["sites"]) else "no"')" "yes"
chk "wrecked site is reported"   "$(printf '%s' "$S" | py '"yes" if any(x["name"]=="wrecked" for x in d.get("broken",[])) else "no"')" "yes"
chk "editor still serves"        "$(curl -s -o /dev/null -w '%{http_code}' "$B/editor/?site=healthy&key=$K")" "200"

echo
echo "── the skip is logged, not silent ──"
if grep -q "could not be loaded and was skipped" "$BOOTLOG"; then L=yes; else L=no; fi
chk "boot log names the problem"  "$L" "yes"

echo
echo "── a wrecked site can be re-ingested to repair it ──"
# It never entered `sites`, so the replace guard does not block a fresh ingest.
HTML='<html><head><title>Repaired</title></head><body><main><h1>Repaired</h1></main></body></html>'
RES=$(curl -s -X POST "$B/api/ingest?key=$K" -H 'Content-Type: application/json' \
  -d "$(printf '{"name":"wrecked","html":%s}' "$(printf '%s' "$HTML" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")")
chk "re-ingest succeeds"          "$(printf '%s' "$RES" | py 'd.get("ok")')" "True"
chk "repaired site now serves"    "$(curl -s "$B/api/sites" | py '"yes" if any(x["name"]=="wrecked" for x in d["sites"]) else "no"')" "yes"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
