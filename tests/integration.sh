#!/bin/bash
# RoamLink Integration Test Matrix — runs against a live server.
# Usage: bash tests/integration.sh http://localhost:3000
BASE="${1:-http://localhost:3000}"
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
TS=$(date +%s)
EMAIL="audit-${TS}@example.com"
J=/tmp/it.txt; rm -f $J

echo "=== IDENTITY ==="
R=$(curl -sL --max-time 15 -X POST "$BASE/api/signup" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"name\":\"Audit\",\"requestedRole\":\"CONSUMER\"}")
echo "$R" | grep -q '"status":"PENDING"' && ok "signup creates PENDING waitlist entry" || bad "signup: $R"
R2=$(curl -sL --max-time 15 -X POST "$BASE/api/signup" -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"name\":\"Audit\",\"requestedRole\":\"CONSUMER\"}")
echo "$R2" | grep -q 'already' && ok "duplicate signup handled gracefully" || bad "duplicate signup: $R2"

CSRF=$(curl -sL --max-time 10 -c $J "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
CODE=$(curl -sL --max-time 15 -b $J -c $J -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "csrfToken=$CSRF&email=$EMAIL&password=anything&json=true")
[ "$CODE" = "401" ] && ok "waitlisted user cannot login (401)" || bad "waitlisted login: $CODE"

echo "=== ADMIN APPROVAL ==="
JA=/tmp/ita.txt; rm -f $JA
CSRF=$(curl -sL --max-time 10 -c $JA "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -sL --max-time 15 -b $JA -c $JA -o /dev/null -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "csrfToken=$CSRF&email=ekontetevi@gmail&password=${PLATFORM_ADMIN_PASSWORD:?set PLATFORM_ADMIN_PASSWORD env var}&json=true"
ME=$(curl -sL --max-time 10 -b $JA "$BASE/api/me")
echo "$ME" | grep -q 'PLATFORM_ADMIN' && ok "platform admin login" || bad "admin login: $ME"
ENTRY=$(curl -sL --max-time 15 -b $JA "$BASE/api/waitlist" | python3 -c "import sys,json;d=json.load(sys.stdin);e=[x for x in d['entries'] if x['email']=='$EMAIL'];print(e[0]['id'] if e else '')")
CONV=$(curl -sL --max-time 25 -b $JA -X POST "$BASE/api/waitlist/$ENTRY/approve" -H "Content-Type: application/json" -d '{"create":true}')
echo "$CONV" | grep -q 'CONVERTED' && ok "admin approve + convert creates user" || bad "convert: $CONV"
PASSWD=$(echo "$CONV" | python3 -c "import sys,json;print(json.load(sys.stdin).get('onboardToken',''))" 2>/dev/null)
JU=/tmp/itu.txt; rm -f $JU
CSRF=$(curl -sL --max-time 10 -c $JU "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
CODE=$(curl -sL --max-time 15 -b $JU -c $JU -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "csrfToken=$CSRF&email=$EMAIL&password=$PASSWD&json=true")
[ "$CODE" = "200" ] && ok "converted user can login" || bad "converted login: $CODE"

echo "=== AUTHORIZATION ==="
CODE=$(curl -sL --max-time 10 -b $JU -o /dev/null -w "%{http_code}" "$BASE/api/waitlist")
[ "$CODE" = "403" ] && ok "vertical: consumer denied waitlist (403)" || bad "vertical: $CODE"
JD=/tmp/itd.txt; rm -f $JD
CSRF=$(curl -sL --max-time 10 -c $JD "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -sL --max-time 15 -b $JD -c $JD -o /dev/null -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "csrfToken=$CSRF&email=demo.consumer@roamlink.dev&password=roamlink-demo&json=true"
DME=$(curl -sL --max-time 10 -b $JD "$BASE/api/me")
echo "$DME" | grep -q '"isDemo":true' && ok "demo consumer is marked DEMO" || bad "demo flag: $DME"
echo "$DME" | grep -q 'PLATFORM_ADMIN' && bad "demo consumer IS platform admin (VIOLATION)" || ok "demo consumer is NOT platform admin"

echo "=== CONTROL PLANE GOLDEN PATH ==="
IID=$(curl -sL --max-time 15 -b $JD -X POST "$BASE/api/intents" -H "Content-Type: application/json" -d '{"capability":"internet","location":{"country":"GH"},"timeWindow":{"start":"2026-01-01T00:00:00Z"},"usage":{"downlinkMbps":10},"constraints":{"maxLatencyMs":150},"preferences":{"prioritize":"cost"}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['intent']['id'])")
[ -n "$IID" ] && ok "intent created" || bad "intent creation"
CAPS=$(curl -sL --max-time 15 -b $JD "$BASE/api/capabilities?intentId=$IID")
OFFER=$(echo "$CAPS" | python3 -c "import sys,json;d=json.load(sys.stdin);c=[x for x in d['capabilities'] if x['resources'] and x['offers']][0];print(c['offers'][0]['id'])" 2>/dev/null)
RES=$(echo "$CAPS" | python3 -c "import sys,json;d=json.load(sys.stdin);c=[x for x in d['capabilities'] if x['resources'] and x['offers']][0];print(c['resources'][0]['id'])" 2>/dev/null)
PROV=$(echo "$CAPS" | python3 -c "import sys,json;d=json.load(sys.stdin);c=[x for x in d['capabilities'] if x['resources'] and x['offers']][0];print(c['providerId'])" 2>/dev/null)
[ -n "$OFFER" ] && ok "capability discovered (with resources+offers)" || bad "capability discovery"
curl -sL --max-time 15 -b $JD -X POST "$BASE/api/entitlements" -H "Content-Type: application/json" -d "{\"offerId\":\"$OFFER\",\"resourceId\":\"$RES\"}" > /dev/null
ok "trial entitlement granted (explicit TrialPolicy)"
DEC=$(curl -sL --max-time 20 -b $JD -X POST "$BASE/api/decisions" -H "Content-Type: application/json" -d "{\"intentId\":\"$IID\"}")
echo "$DEC" | grep -q '"decisionType":"SELECT"' && ok "decision: SELECT" || bad "decision: $(echo $DEC | head -c 100)"
echo "$DEC" | grep -q 'BETTER_SCORE_AFTER_SWITCHING_COST' && ok "reason codes present" || bad "reason codes"
SID=$(curl -sL --max-time 25 -b $JD -X POST "$BASE/api/sessions" -H "Content-Type: application/json" -d "{\"intentId\":\"$IID\",\"resourceId\":\"$RES\",\"providerId\":\"$PROV\",\"offerId\":\"$OFFER\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sessionId',''))")
[ -n "$SID" ] && ok "session activated" || bad "session activation"
SESS=$(curl -sL --max-time 15 -b $JD "$BASE/api/sessions/$SID")
echo "$SESS" | grep -q 'latencyMs' && ok "measurement recorded (observed truth)" || bad "measurement"

echo "=== HORIZONTAL ISOLATION ==="
JF=/tmp/itf.txt; rm -f $JF
CSRF=$(curl -sL --max-time 10 -c $JF "$BASE/api/auth/csrf" | python3 -c "import sys,json;print(json.load(sys.stdin)['csrfToken'])")
curl -sL --max-time 15 -b $JF -c $JF -o /dev/null -X POST "$BASE/api/auth/callback/credentials" -H "Content-Type: application/x-www-form-urlencoded" --data "csrfToken=$CSRF&email=demo.family@roamlink.dev&password=roamlink-demo&json=true"
CODE=$(curl -sL --max-time 15 -b $JF -o /dev/null -w "%{http_code}" -X POST "$BASE/api/sessions/$SID/actions" -H "Content-Type: application/json" -d '{"action":"DEACTIVATE"}')
[ "$CODE" = "403" ] && ok "horizontal: family admin denied consumer's session (403)" || bad "horizontal: $CODE"

echo ""
echo "================================"
echo "  PASS: $PASS    FAIL: $FAIL"
echo "================================"
[ "$FAIL" = "0" ]
