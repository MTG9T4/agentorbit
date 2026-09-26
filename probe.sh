#!/bin/sh
# AgentOrbit probe. Contract:
#   GET /            -> 200 HTML with the brand + honesty line
#   GET /api/orbit   -> 200 JSON { fetchedAt, coins[], stale }; coins all have
#                       valid mint + name; no nsfw/banned; no duplicate names
#   GET /api/orbit twice quickly -> same fetchedAt (cache within TTL)
#   GET /c/{mint}    -> 200 with og:title containing the escaped coin name
#   GET /c/{badmint} -> 404 honest page
#   POST /api/orbit  -> 405
#   GET /data/seed-cache.json -> 200 (zero-config fallback present)
# Usage: sh probe.sh <base>  (default http://localhost:8788 under
#   `npx wrangler pages dev . --port 8788`)
# Prints PASS/FAIL per assertion; exit code = failure count.
set -u
BASE="${1:-http://localhost:8788}"
TMP="$(mktemp -d)"
FAIL=0

check() { # $1 desc, $2 got, $3 want
  if [ "$2" = "$3" ]; then echo "PASS  $1 (got $2)"; else echo "FAIL  $1 (got $2, want $3)"; FAIL=$((FAIL+1)); fi
}

CODE=$(curl -s -o "$TMP/root.html" -w "%{http_code}" "$BASE/")
check "GET / -> 200" "$CODE" "200"
grep -q "Agent" "$TMP/root.html" && echo "PASS  / carries the brand" || { echo "FAIL  / missing brand"; FAIL=$((FAIL+1)); }
grep -q "not financial advice" "$TMP/root.html" && echo "PASS  / carries the honesty line" || { echo "FAIL  / missing honesty line"; FAIL=$((FAIL+1)); }

CODE=$(curl -s -o "$TMP/orbit1.json" -w "%{http_code}" "$BASE/api/orbit")
check "GET /api/orbit -> 200" "$CODE" "200"
if [ -s "$TMP/orbit1.json" ]; then
  node -e "
    const fs = require('fs');
    const d = JSON.parse(fs.readFileSync('$TMP/orbit1.json', 'utf8'));
    let bad = [];
    if (!Array.isArray(d.coins) || d.coins.length === 0) bad.push('no coins');
    const names = new Set();
    for (const c of d.coins || []) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.mint || '')) bad.push('bad mint: ' + c.mint);
      if (!c.name) bad.push('missing name');
      if (names.has(c.name.toLowerCase())) bad.push('duplicate name: ' + c.name);
      names.add(c.name.toLowerCase());
    }
    if (typeof d.fetchedAt !== 'number') bad.push('no fetchedAt');
    if (typeof d.stale !== 'boolean') bad.push('no stale flag');
    console.log((d.coins || []).length + ' coins, fetchedAt=' + d.fetchedAt + ', stale=' + d.stale);
    if (bad.length) { console.log(bad.join('; ')); process.exit(1); }
  " && echo "PASS  orbit payload shape valid" || { echo "FAIL  orbit payload invalid"; FAIL=$((FAIL+1)); }
  MINT=$(node -e "const d=JSON.parse(require('fs').readFileSync('$TMP/orbit1.json','utf8'));console.log((d.coins.find(c=>c.curated)||d.coins[0]).mint)")
  NAME=$(node -e "const d=JSON.parse(require('fs').readFileSync('$TMP/orbit1.json','utf8'));console.log((d.coins.find(c=>c.curated)||d.coins[0]).name.replace(/\"/g,''))")

  sleep 2
  CODE=$(curl -s -o "$TMP/orbit2.json" -w "%{http_code}" "$BASE/api/orbit")
  check "GET /api/orbit again -> 200" "$CODE" "200"
  node -e "
    const fs = require('fs');
    const a = JSON.parse(fs.readFileSync('$TMP/orbit1.json', 'utf8'));
    const b = JSON.parse(fs.readFileSync('$TMP/orbit2.json', 'utf8'));
    // Fresh cache: fetchedAt must be identical. Stale cache (over TTL): the
    // background refresh is allowed to have written a new fetchedAt.
    if (!a.stale && a.fetchedAt !== b.fetchedAt) { console.log('fresh cache changed fetchedAt'); process.exit(1); }
    if (a.stale && b.fetchedAt < a.fetchedAt) { console.log('stale refresh went backwards'); process.exit(1); }
    process.exit(0);
  " && echo "PASS  TTL contract honored (fresh hit identical / stale may refresh)" || { echo "FAIL  TTL contract violated"; FAIL=$((FAIL+1)); }

  CODE=$(curl -s -o "$TMP/coin.html" -w "%{http_code}" "$BASE/c/$MINT")
  check "GET /c/{mint} -> 200" "$CODE" "200"
  grep -q "og:title" "$TMP/coin.html" && echo "PASS  /c/{mint} carries og:title" || { echo "FAIL  /c/{mint} missing og meta"; FAIL=$((FAIL+1)); }
  grep -q "$NAME" "$TMP/coin.html" && echo "PASS  /c/{mint} shows the coin name" || { echo "FAIL  /c/{mint} missing coin name"; FAIL=$((FAIL+1)); }

  CODE=$(curl -s -o "$TMP/nf.html" -w "%{http_code}" "$BASE/c/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz1")
  check "GET /c/{unknown mint} -> 404" "$CODE" "404"
  grep -q "not found" "$(echo "$TMP/nf.html")" && echo "PASS  404 page is honest" || { echo "FAIL  404 page missing copy"; FAIL=$((FAIL+1)); }
else
  echo "FAIL  /api/orbit returned no body"; FAIL=$((FAIL+1))
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/orbit")
check "POST /api/orbit -> 405" "$CODE" "405"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/data/seed-cache.json")
check "seed cache served -> 200" "$CODE" "200"

rm -rf "$TMP"
echo "----"
echo "failures: $FAIL"
exit $FAIL
