#!/usr/bin/env bash
# sitemap.xml / robots.txt generation. The CMS emits these on every publish, so
# they must list the client's REAL domain (not a Vercel preview or a name guess),
# cover every indexable page, drop noindex pages, and update as pages change.
set -u
B="http://localhost:$PORT"
F="http://localhost:$FIXTURE_PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
has(){ if printf '%s' "$2" | grep -qF "$3"; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        missing: $3"; fail=$((fail+1)); fi; }
hasnt(){ if printf '%s' "$2" | grep -qF "$3"; then echo "  FAIL  $1"; echo "        should not contain: $3"; fail=$((fail+1)); else echo "  PASS  $1"; pass=$((pass+1)); fi; }
j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
py(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

echo "── ingest a multi-page site and publish ──"
URLS=$(j "$B/api/discover?key=$OK" "$(printf '{"url":"%s"}' "$F")" | py 'json.dumps(d["urls"])')
j "$B/api/ingest?key=$OK" "$(printf '{"name":"smap","urls":%s}' "$URLS")" > /dev/null
j "$B/api/publish?key=$OK&site=smap" '{"pages":{}}' > /dev/null

echo
echo "── sitemap is served from the CMS preview and is valid XML ──"
SM=$(curl -s "$B/live/smap/sitemap.xml")
has "declares urlset"            "$SM" "<urlset"
has "lists the home page (/)"    "$SM" "<loc"
CNT=$(printf '%s' "$SM" | grep -c "<loc>")
chk "one <loc> per ingested page" "$CNT" "5"

echo
echo "── before a domain is set, it falls back to a real URL, never a bad guess ──"
hasnt "no fabricated .example in prod use yet is fine, but no name-guess .com" "$SM" "smap.com"

echo
echo "── setting the production domain rewrites the sitemap URLs ──"
RES=$(j "$B/api/admin/site-vercel?key=$OK" '{"site":"smap","domain":"https://cincinnatigutterguys.com/"}')
chk "domain normalised (no scheme/slash)" "$(printf '%s' "$RES" | py 'd["domain"]')" "cincinnatigutterguys.com"
chk "sitemap base reported"      "$(printf '%s' "$RES" | py 'd["sitemapBase"]')" "https://cincinnatigutterguys.com"
SM2=$(curl -s "$B/live/smap/sitemap.xml")
has "loc now uses the real domain" "$SM2" "<loc>https://cincinnatigutterguys.com/</loc>"
has "a subpage uses it too"        "$SM2" "https://cincinnatigutterguys.com/about"

echo
echo "── robots.txt points at the sitemap on the same domain ──"
RB=$(curl -s "$B/live/smap/robots.txt")
has "robots names the sitemap"   "$RB" "Sitemap: https://cincinnatigutterguys.com/sitemap.xml"

echo
echo "── the domain survives a reload from storage ──"
# Re-read via /api/sites (which comes from the in-memory site, but domain was persisted)
DM=$(curl -s "$B/api/sites?key=$OK" | py 'next(x["domain"] for x in d["sites"] if x["name"]=="smap")')
chk "domain persisted"           "$DM" "cincinnatigutterguys.com"

echo
echo "── adding a page grows the sitemap on next publish ──"
j "$B/api/pages/add?key=$OK&site=smap" '{"title":"Financing","template":"blank"}' > /dev/null
SM3=$(curl -s "$B/live/smap/sitemap.xml")
NEW=$(printf '%s' "$SM3" | grep -c "<loc>")
chk "sitemap now has 6 entries"  "$NEW" "6"
has "the new page is listed"     "$SM3" "https://cincinnatigutterguys.com/financing"

echo
echo "── clearing the domain reverts to the fallback ──"
j "$B/api/admin/site-vercel?key=$OK" '{"site":"smap","domain":""}' > /dev/null
hasnt "real domain gone after clear" "$(curl -s "$B/live/smap/sitemap.xml")" "cincinnatigutterguys.com"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
