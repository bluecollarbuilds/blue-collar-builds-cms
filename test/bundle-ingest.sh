#!/usr/bin/env bash
# Ingesting a site from its BUILT OUTPUT (a zipped dist/), which is the reliable
# path. These checks pin the two failures that made URL-capture unusable on a real
# client site: JavaScript stripped out (leaving the mobile menu stuck open) and
# responsive images broken because srcset was never handled.
set -u
B="http://localhost:$PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
has(){ if printf '%s' "$2" | grep -qF -- "$3"; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        missing: $3"; fail=$((fail+1)); fi; }
hasnt(){ if printf '%s' "$2" | grep -qF -- "$3"; then echo "  FAIL  $1"; echo "        should not contain: $3"; fail=$((fail+1)); else echo "  PASS  $1"; pass=$((pass+1)); fi; }
py(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ZIP=/tmp/cms-test-dist.zip

echo "── build a dist/ zip and ingest it ──"
node test/make-bundle.mjs "$ZIP" > /dev/null
ING=$(curl -s -X POST "$B/api/ingest-bundle?key=$OK&name=built" -H 'Content-Type: application/zip' --data-binary "@$ZIP")
chk "4 html pages became pages"  "$(printf '%s' "$ING" | py 'd.get("pages")')" "4"
chk "assets stored"              "$(printf '%s' "$ING" | py '"yes" if d.get("assets",0) >= 9 else "no"')" "yes"
chk "editable fields found"      "$(printf '%s' "$ING" | py '"yes" if d.get("fields",0) > 5 else "no"')" "yes"
chk "home is first"              "$(printf '%s' "$ING" | py 'd["added"][0]["slug"]')" "home"
chk "junk file ignored"          "$(printf '%s' "$ING" | py '"yes" if not any(".DS_Store" in a.get("file","") for a in d["added"]) else "no"')" "yes"

echo
echo "── the site's REAL urls are preserved ──"
PAGES=$(curl -s "$B/api/pages?site=built&key=$OK")
chk "services keeps /services"   "$(printf '%s' "$PAGES" | py 'next(p["path"] for p in d["pages"] if p["slug"]=="services")')" "/services"
chk "titles came from <title>"   "$(printf '%s' "$PAGES" | py 'next(p["title"] for p in d["pages"] if p["slug"]=="pricing")')" "Pricing — Gutter Guys"

echo
echo "── THE MENU BUG: the site's own scripts survive ──"
curl -s -X POST "$B/api/publish?key=$OK&site=built" -H 'Content-Type: application/json' -d '{"pages":{}}' > /dev/null
LIVE=$(curl -s "$B/live/built")
has "script tag kept"            "$LIVE" "nav.js"
chk "the script file is served"  "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/built/_astro/nav.js")" "200"
has "the closing js is intact"   "$(curl -s "$B/live/built/_astro/nav.js")" "classList.remove('open')"

echo
echo "── THE IMAGE BUG: responsive images are complete ──"
has "picture source kept"        "$LIVE" "hero.a1.avif"
has "img srcset kept"            "$LIVE" "srcset"
chk "logo is served"             "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/built/_astro/logo.CxY9_1z-.svg")" "200"
chk "webp hero is served"        "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/built/_astro/hero.a1.webp")" "200"
chk "2x avif is served"          "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/built/_astro/hero@2x.a1.avif")" "200"

echo
echo "── css and the files it pulls in ──"
CSS=$(curl -s "$B/live/built/_astro/main.BX3kd2Aa.css")
has "stylesheet served"          "$CSS" "rebeccapurple"
hasnt "no unresolved marker"     "$CSS" "__cms-asset"
has "font url resolved"          "$CSS" "/live/built/_astro/brand.woff2"
chk "font served"                "$(curl -s -o /dev/null -w '%{http_code}' "$B/live/built/_astro/brand.woff2")" "200"

echo
echo "── the deploy bundle carries the whole site ──"
BUNDLE=$(curl -s "$B/api/admin/deploy-preview?key=$OK&site=built")
chk "keeps services/index.html"  "$(printf '%s' "$BUNDLE" | py '"yes" if "services/index.html" in d["files"] else "no"')" "yes"
chk "ships the script"           "$(printf '%s' "$BUNDLE" | py '"yes" if "_astro/nav.js" in d["files"] else "no"')" "yes"
chk "ships the stylesheet"       "$(printf '%s' "$BUNDLE" | py '"yes" if "_astro/main.BX3kd2Aa.css" in d["files"] else "no"')" "yes"
chk "ships every image"          "$(printf '%s' "$BUNDLE" | py '"yes" if all(f in d["files"] for f in ["_astro/hero.a1.webp","_astro/hero@2x.a1.avif","_astro/logo.CxY9_1z-.svg"]) else "no"')" "yes"
chk "no marker escapes"          "$(printf '%s' "$BUNDLE" | py '"leak" if "__cms-asset" in json.dumps(d) else "clean"')" "clean"
IDX=$(printf '%s' "$BUNDLE" | py 'd["indexHtml"]')
has "deployed paths are root-relative" "$IDX" '"/_astro/main.BX3kd2Aa.css"'
hasnt "no /live/ prefix in deploy"     "$IDX" "/live/built"

echo
echo "── content is still editable ──"
FIELD=$(curl -s "$B/api/state?site=built&key=$OK" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for g in (d.get("groups") or {}).values():
    for f in g:
        if not f.get("rich") and f.get("type")!="image" and not str(f.get("id","")).startswith("seo:"):
            print(f["id"]); sys.exit()
print("")')
chk "an editable text field exists" "$(test -n "$FIELD" && echo yes || echo no)" "yes"
SAVE=$(curl -s -X POST "$B/api/publish?key=$OK&site=built" -H 'Content-Type: application/json' -d "$(printf '{"pages":{"home":{"%s":"EDITED HEADLINE"}}}' "$FIELD")")
chk "edit publishes"             "$(printf '%s' "$SAVE" | py 'd.get("ok")')" "True"
EDITED=$(curl -s "$B/live/built")
has "edit is live"               "$EDITED" "EDITED HEADLINE"
has "script still there after edit" "$EDITED" "nav.js"

echo
echo "── replace keeps the client relationship ──"
curl -s -X POST "$B/api/admin/set-password?key=$OK" -H 'Content-Type: application/json' -d '{"site":"built","password":"clientpw123"}' > /dev/null
curl -s -X POST "$B/api/ingest-bundle?key=$OK&name=built&replace=1" -H 'Content-Type: application/zip' --data-binary "@$ZIP" > /dev/null
chk "client access survived"     "$(curl -s "$B/api/sites?key=$OK" | py 'next(x["handedOff"] for x in d["sites"] if x["name"]=="built")')" "True"

echo
echo "── guardrails ──"
chk "second ingest needs replace" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/ingest-bundle?key=$OK&name=built" -H 'Content-Type: application/zip' --data-binary "@$ZIP")" "409"
chk "a non-zip is refused"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/ingest-bundle?key=$OK&name=notzip" -H 'Content-Type: application/zip' --data-binary 'not a zip at all')" "400"
chk "clients cannot ingest"       "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/ingest-bundle?key=clientpw123&name=x2" -H 'Content-Type: application/zip' --data-binary "@$ZIP")" "401"

rm -f "$ZIP"
echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
