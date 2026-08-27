#!/usr/bin/env bash
# Asset mirroring — the guard against the bug that stripped a live client site bare.
#
# A Vercel deployment REPLACES the whole site rather than patching it, so a bundle
# of HTML alone deletes the /_astro/*.css the HTML links to. These checks assert the
# published bundle carries the site's own styling, fonts and images with it.
set -u
B="http://localhost:$PORT"
F="http://localhost:$FIXTURE_PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
has(){ if printf '%s' "$2" | grep -qF -- "$3"; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        missing: $3"; fail=$((fail+1)); fi; }
hasnt(){ if printf '%s' "$2" | grep -qF -- "$3"; then echo "  FAIL  $1"; echo "        should not contain: $3"; fail=$((fail+1)); else echo "  PASS  $1"; pass=$((pass+1)); fi; }
j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
py(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

echo "── ingest a styled site ──"
ING=$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"styled","urls":["%s/","%s/about"]}' "$F" "$F")")
chk "2 pages ingested"        "$(printf '%s' "$ING" | py 'd.get("pages")')" "2"
# stylesheet + favicon + hero + font + background = 5 distinct files
chk "assets were mirrored"    "$(printf '%s' "$ING" | py '"yes" if d.get("assets",0) >= 5 else "no"')" "yes"
chk "no asset failures"       "$(printf '%s' "$ING" | py 'len(d.get("assetFailures",[]))')" "0"

echo
echo "── the mirrored files are served, with correct content types ──"
CSS=$(curl -s "$B/live/styled/_astro/main.abc123.css")
has "stylesheet is served"    "$CSS" "rebeccapurple"
chk "css content-type"        "$(curl -s -o /dev/null -w '%{content_type}' "$B/live/styled/_astro/main.abc123.css")" "text/css; charset=utf-8"
chk "font is served"          "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/styled/_astro/fix.woff2")" "200"
chk "image is served"         "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/styled/_astro/hero.png")" "200"
chk "favicon is served"       "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/styled/favicon.svg")" "200"

echo
echo "── files referenced from INSIDE the css are mirrored and rewritten ──"
# A stylesheet whose @font-face still points at the old host breaks just as loudly.
hasnt "css no longer points at the origin host" "$CSS" "localhost:$FIXTURE_PORT"
hasnt "css has no unresolved marker"            "$CSS" "__cms-asset"
has "font url points under this site"           "$CSS" "/live/styled/_astro/fix.woff2"
has "background url points under this site"     "$CSS" "/live/styled/_astro/bg.png"

echo
echo "── the published page links to the mirrored copies, not the old host ──"
j "$B/api/publish?key=$OK&site=styled" '{"pages":{}}' > /dev/null
LIVE=$(curl -s "$B/live/styled")
hasnt "page does not reference the origin host" "$LIVE" "localhost:$FIXTURE_PORT/_astro"
has "stylesheet link points at our copy"        "$LIVE" "/live/styled/_astro/main.abc123.css"

echo
echo "── THE REGRESSION: the deploy bundle must carry the assets ──"
# This is what actually ships to Vercel. Publishing HTML alone deleted the CSS.
BUNDLE=$(curl -s "$B/api/admin/deploy-preview?key=$OK&site=styled")
chk "bundle lists index.html"     "$(printf '%s' "$BUNDLE" | py '"yes" if "index.html" in d["files"] else "no"')" "yes"
chk "bundle carries the stylesheet" "$(printf '%s' "$BUNDLE" | py '"yes" if "_astro/main.abc123.css" in d["files"] else "no"')" "yes"
chk "bundle carries the font"     "$(printf '%s' "$BUNDLE" | py '"yes" if "_astro/fix.woff2" in d["files"] else "no"')" "yes"
chk "bundle carries the image"    "$(printf '%s' "$BUNDLE" | py '"yes" if "_astro/hero.png" in d["files"] else "no"')" "yes"
chk "bundle carries the sitemap"  "$(printf '%s' "$BUNDLE" | py '"yes" if "sitemap.xml" in d["files"] else "no"')" "yes"

echo
echo "── in the deployed copy the paths are site-root relative ──"
BCSS=$(printf '%s' "$BUNDLE" | py '"has-marker" if "__cms-asset" in json.dumps(d) else "clean"')
chk "no marker anywhere in the bundle" "$BCSS" "clean"
IDX=$(printf '%s' "$BUNDLE" | py 'd["indexHtml"]')
has "deployed html uses /_astro/..."   "$IDX" '"/_astro/main.abc123.css"'
hasnt "deployed html has no /live/ prefix" "$IDX" "/live/styled"
hasnt "deployed html has no internal marker" "$IDX" "__cms-asset"

echo
echo "── capturing a page later mirrors its assets too ──"
ADD=$(j "$B/api/pages/add?key=$OK&site=styled" "$(printf '{"url":"%s/contact"}' "$F")")
chk "page captured"           "$(printf '%s' "$ADD" | py 'd.get("ok")')" "True"
chk "its stylesheet is present" "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/styled/_astro/main.abc123.css")" "200"

echo
echo "── third-party assets are left alone, not re-hosted ──"
TP='<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body><main><h1>Hi</h1></main></body></html>'
j "$B/api/ingest?key=$OK" "$(printf '{"name":"thirdparty","html":%s,"baseUrl":"%s/"}' "$(printf '%s' "$TP" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" "$F")" > /dev/null
j "$B/api/publish?key=$OK&site=thirdparty" '{"pages":{}}' > /dev/null
has "cdn url kept as-is" "$(curl -s "$B/live/thirdparty")" "https://cdn.example.com/x.css"

echo
echo "── traversal out of the asset directory is refused ──"
chk "../ is rejected" "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$B/live/styled/../../server.mjs")" "404"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
