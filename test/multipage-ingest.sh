#!/usr/bin/env bash
# Multi-page ingest, page discovery, and capturing a page into an existing site.
# Runs against test/fixture-site.mjs — a real HTTP server with a sitemap, nested
# routes, a PDF, a redirect and a 404, so the fetch path is exercised for real.
set -u
B="http://localhost:$PORT"
F="http://localhost:$FIXTURE_PORT"
OK="$ADMIN_KEY"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  PASS  $1"; pass=$((pass+1)); else echo "  FAIL  $1"; echo "        expected $3, got $2"; fail=$((fail+1)); fi; }
j(){ curl -s -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
code(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' -d "$2"; }
py(){ python3 -c "
import json,sys
d=json.load(sys.stdin)
print($1)
"; }

echo "── discovery reads the sitemap ──"
DISC=$(j "$B/api/discover?key=$OK" "$(printf '{"url":"%s"}' "$F")")
chk "finds all 5 real pages"    "$(printf '%s' "$DISC" | py 'len(d["urls"])')" "5"
chk "excludes the PDF"          "$(printf '%s' "$DISC" | py '"yes" if not any(u.endswith(".pdf") for u in d["urls"]) else "no"')" "yes"
chk "excludes off-site links"   "$(printf '%s' "$DISC" | py '"yes" if not any("example.com" in u for u in d["urls"]) else "no"')" "yes"
chk "derives a nested slug"     "$(printf '%s' "$DISC" | py 'next(p["slug"] for p in d["pages"] if p["path"]=="/services/plumbing")')" "services-plumbing"

echo
echo "── ingesting every discovered page at once ──"
URLS=$(printf '%s' "$DISC" | py 'json.dumps(d["urls"])')
ING=$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"multi","urls":%s}' "$URLS")")
chk "reports 5 pages"           "$(printf '%s' "$ING" | py 'd.get("pages")')" "5"
chk "nothing failed"            "$(printf '%s' "$ING" | py 'len(d.get("failed",[]))')" "0"
chk "captured real fields"      "$(printf '%s' "$ING" | py '"yes" if d["fields"] > 10 else "no"')" "yes"

PAGES=$(curl -s "$B/api/pages?site=multi&key=$OK")
chk "home is the first page"    "$(printf '%s' "$PAGES" | py 'd["home"]')" "home"
chk "5 pages registered"        "$(printf '%s' "$PAGES" | py 'len(d["pages"])')" "5"
chk "about page exists"         "$(printf '%s' "$PAGES" | py '"yes" if any(p["slug"]=="about" for p in d["pages"]) else "no"')" "yes"
chk "nested page kept its slug" "$(printf '%s' "$PAGES" | py '"yes" if any(p["slug"]=="services-plumbing" for p in d["pages"]) else "no"')" "yes"
chk "title came from <title>"   "$(printf '%s' "$PAGES" | py 'next(p["title"] for p in d["pages"] if p["slug"]=="about")')" "About Fixture Co"

echo
echo "── each page kept its OWN content, not a copy of home ──"
j "$B/api/publish?key=$OK&site=multi" '{"pages":{}}' > /dev/null
ABOUT=$(curl -s "$B/live/multi/about")
CONTACT=$(curl -s "$B/live/multi/contact")
if printf '%s' "$ABOUT" | grep -q "Founded in a garage"; then A=yes; else A=no; fi
if printf '%s' "$CONTACT" | grep -q "Call us maybe"; then C=yes; else C=no; fi
if printf '%s' "$ABOUT" | grep -q "Call us maybe"; then X=bled; else X=clean; fi
chk "about has its own body"    "$A" "yes"
chk "contact has its own body"  "$C" "yes"
chk "pages did not bleed"       "$X" "clean"

echo
echo "── a dead URL among good ones is reported, not fatal ──"
MIX=$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"mixed","replace":true,"urls":["%s/","%s/nope-404","%s/about"]}' "$F" "$F" "$F")")
chk "good pages still ingested" "$(printf '%s' "$MIX" | py 'd.get("pages")')" "2"
chk "the bad URL is reported"   "$(printf '%s' "$MIX" | py 'len(d.get("failed",[]))')" "1"
chk "failure names the status"  "$(printf '%s' "$MIX" | py '"yes" if "404" in d["failed"][0]["error"] else "no"')" "yes"

echo
echo "── re-ingesting an existing site is blocked without replace ──"
chk "second ingest is refused"  "$(code "$B/api/ingest?key=$OK" "$(printf '{"name":"multi","urls":["%s/"]}' "$F")")" "409"
STILL=$(curl -s "$B/api/pages?site=multi&key=$OK")
chk "the site is untouched"     "$(printf '%s' "$STILL" | py 'len(d["pages"])')" "5"
chk "replace:true does replace" "$(printf '%s' "$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"multi","replace":true,"urls":["%s/","%s/about"]}' "$F" "$F")")" | py 'd.get("pages")')" "2"

echo
echo "── capturing a page into an EXISTING site (the later-pages case) ──"
ADD=$(j "$B/api/pages/add?key=$OK&site=multi" "$(printf '{"url":"%s/contact"}' "$F")")
chk "page/add from URL works"   "$(printf '%s' "$ADD" | py 'd.get("ok")')" "True"
chk "flagged as captured"       "$(printf '%s' "$ADD" | py 'd.get("captured")')" "True"
chk "slug from the URL"         "$(printf '%s' "$ADD" | py 'd["slug"]')" "contact"
chk "title from the page"       "$(printf '%s' "$ADD" | py 'd["title"]')" "Contact Fixture Co"
chk "brought real fields"       "$(printf '%s' "$ADD" | py '"yes" if d["fields"] > 3 else "no"')" "yes"

AFTER=$(curl -s "$B/api/pages?site=multi&key=$OK")
chk "site grew to 3 pages"      "$(printf '%s' "$AFTER" | py 'len(d["pages"])')" "3"
chk "existing pages survived"   "$(printf '%s' "$AFTER" | py '"yes" if any(p["slug"]=="about" for p in d["pages"]) else "no"')" "yes"

j "$B/api/publish?key=$OK&site=multi" '{"pages":{}}' > /dev/null
if curl -s "$B/live/multi/contact" | grep -q "Call us maybe"; then L=yes; else L=no; fi
chk "captured page serves live" "$L" "yes"

echo
echo "── adding the same URL twice does not collide ──"
j "$B/api/pages/add?key=$OK&site=multi" "$(printf '{"url":"%s/contact"}' "$F")" > /dev/null
DUP=$(curl -s "$B/api/pages?site=multi&key=$OK")
chk "second copy got its own slug" "$(printf '%s' "$DUP" | py '"yes" if any(p["slug"]=="contact-2" for p in d["pages"]) else "no"')" "yes"

echo
echo "── non-HTML and bad input are refused ──"
chk "a PDF is refused"          "$(code "$B/api/pages/add?key=$OK&site=multi" "$(printf '{"url":"%s/brochure.pdf"}' "$F")")" "400"
chk "garbage URL is refused"    "$(code "$B/api/pages/add?key=$OK&site=multi" '{"url":"not a url"}')" "400"

echo
echo "── blank/article templates still work ──"
BLANK=$(j "$B/api/pages/add?key=$OK&site=multi" '{"title":"Careers","template":"blank"}')
chk "blank page still adds"     "$(printf '%s' "$BLANK" | py 'd.get("ok")')" "True"
chk "blank is not 'captured'"   "$(printf '%s' "$BLANK" | py 'd.get("captured")')" "False"

echo
echo "── a redirect is followed ──"
RED=$(j "$B/api/pages/add?key=$OK&site=multi" "$(printf '{"url":"%s/moved","slug":"moved"}' "$F")")
chk "redirect resolved to About" "$(printf '%s' "$RED" | py 'd.get("ok")')" "True"

echo
echo "── editors may capture pages; clients may not ──"
EK=$(j "$B/api/admin/team/add?key=$OK" '{"name":"Cap Turer","role":"editor"}' | py 'd["key"]')
chk "editor can capture"        "$(code "$B/api/pages/add?key=$EK&site=multi" "$(printf '{"url":"%s/services","slug":"svc"}' "$F")")" "200"
chk "editor can discover"       "$(code "$B/api/discover?key=$EK" "$(printf '{"url":"%s"}' "$F")")" "200"
j "$B/api/admin/set-password?key=$OK" '{"site":"multi","password":"clientpw123"}' > /dev/null
chk "client CANNOT discover"    "$(code "$B/api/discover?key=clientpw123" "$(printf '{"url":"%s"}' "$F")")" "401"
chk "client CANNOT capture from a URL" "$(code "$B/api/pages/add?site=multi&key=clientpw123" "$(printf '{"url":"%s/about"}' "$F")")" "401"
chk "client can still add a blank page" "$(code "$B/api/pages/add?site=multi&key=clientpw123" '{"title":"Client Page","template":"blank"}')" "200"

echo
echo "── the home page is the anchor: a dead FIRST url fails the ingest ──"
DEAD=$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"deadhome","urls":["%s/nope-404","%s/about"]}' "$F" "$F")")
chk "ingest refused"            "$(printf '%s' "$DEAD" | py '"yes" if d.get("error") and "home page" in d["error"] else "no"')" "yes"
chk "no half-site left behind"  "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/pages?site=deadhome&key=$OK")" "404"

echo
echo "── replacing a site keeps its client access and Vercel link ──"
j "$B/api/admin/site-vercel?key=$OK" '{"site":"multi","project":"multi-vercel-proj"}' > /dev/null
REP=$(j "$B/api/ingest?key=$OK" "$(printf '{"name":"multi","replace":true,"urls":["%s/","%s/about"]}' "$F" "$F")")
chk "replace succeeded"         "$(printf '%s' "$REP" | py 'd.get("ok")')" "True"
INFO=$(curl -s "$B/api/sites?key=$OK" | py 'json.dumps(next(x for x in d["sites"] if x["name"]=="multi"))')
chk "client access survived"    "$(printf '%s' "$INFO" | py 'd["handedOff"]')" "True"
chk "vercel link survived"      "$(printf '%s' "$INFO" | py 'd["vercelProject"]')" "multi-vercel-proj"
chk "client key still works"    "$(code "$B/api/save?site=multi&key=clientpw123" '{"pages":{}}')" "400"   # 400 'nothing to save' = authenticated

echo
echo "── offboarding: sites can be removed, carefully ──"
chk "editor cannot delete"      "$(code "$B/api/admin/site-delete?key=$EK" '{"site":"multi","confirm":"multi"}')" "401"
chk "wrong confirmation refused" "$(code "$B/api/admin/site-delete?key=$OK" '{"site":"multi","confirm":"mulit"}')" "400"
chk "correct confirmation deletes" "$(code "$B/api/admin/site-delete?key=$OK" '{"site":"multi","confirm":"multi"}')" "200"
chk "the site is gone"          "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/pages?site=multi&key=$OK")" "404"
chk "unknown site delete is 404" "$(code "$B/api/admin/site-delete?key=$OK" '{"site":"multi","confirm":"multi"}')" "404"

echo
echo "════ $pass passed, $fail failed ════"
exit $((fail>0))
