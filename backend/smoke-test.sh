#!/usr/bin/env bash
# End-to-end smoke test against a live server + real Postgres. Not a unit
# test suite — a scripted proof that the whole vertical slice actually works:
# auth, office scoping (including the HQ-sees-everything fix), job creation,
# the setting-charge guard, and the branch<->HQ status sync in both directions.
set -euo pipefail
BASE=http://127.0.0.1:4000/api
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS+1))
  else
    echo "  ❌ $desc — expected [$want] got [$got]"
    FAIL=$((FAIL+1))
  fi
}

echo "=== 1. Login as four different accounts ==="
login() { curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo1234\"}" | jq -r .token; }
ADMIN_TOKEN=$(login admin@worldshiner.demo)
TEXAS_TOKEN=$(login texas.staff@worldshiner.demo)
TEXAS_MASTER_TOKEN=$(login texas.master@worldshiner.demo)
SYDNEY_TOKEN=$(login sydney.staff@worldshiner.demo)
INDIA_TOKEN=$(login india.staff@worldshiner.demo)
for t in ADMIN_TOKEN TEXAS_TOKEN TEXAS_MASTER_TOKEN SYDNEY_TOKEN INDIA_TOKEN; do
  [ "${!t}" != "null" ] && [ -n "${!t}" ] && echo "  ✅ $t acquired" && PASS=$((PASS+1)) || { echo "  ❌ $t missing"; FAIL=$((FAIL+1)); }
done

echo "=== 2. Wrong password is rejected ==="
BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"email":"texas.staff@worldshiner.demo","password":"wrong"}')
check "wrong password -> 401" "$BAD" "401"

echo "=== 3. Office visibility: admin=all, HQ=all, branch=own-only ==="
ADMIN_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.offices | length')
check "super admin sees all 12 offices (both orgs)" "$ADMIN_OFFICES" "12"
INDIA_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $INDIA_TOKEN" | jq '.offices | length')
check "HQ staff sees all 10 offices (not just HQ's own)" "$INDIA_OFFICES" "10"
TEXAS_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.offices | length')
check "branch staff sees only their own office" "$TEXAS_OFFICES" "1"

echo "=== 4. Status vocab seeded correctly ==="
STATUS_COUNT=$(curl -s "$BASE/offices/statuses" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.statuses | length')
check "34 branch statuses available" "$STATUS_COUNT" "34"

echo "=== 5. Create jobs as Texas staff ==="
JOB_A=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jobName":"PHENIX JWY - JOHN SMITH","contactPerson":"JAILYN","priority":"High","notes":"Standard order. Customer supplied full design brief."}')
JOB_A_ID=$(echo "$JOB_A" | jq -r .job.id)
JOB_A_OFFICE=$(echo "$JOB_A" | jq -r .job.office_id)
check "job A created with an id" "$([ -n "$JOB_A_ID" ] && [ "$JOB_A_ID" != "null" ] && echo yes)" "yes"

JOB_B=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jobName":"RIVIERA JWY - A CLIENT","contactPerson":"DANA","clientStoneSemiMount":true,"notes":"Client bringing their own centre stone."}')
JOB_B_ID=$(echo "$JOB_B" | jq -r .job.id)
echo "  job A id=$JOB_A_ID (office_id=$JOB_A_OFFICE), job B id=$JOB_B_ID"

echo "=== 6. Office is derived server-side, NOT from client input (the root-cause fix) ==="
# Texas staff has no isGlobalAdmin, so an ?office=WS-SYD override must be silently ignored.
SNEAKY=$(curl -s -X POST "$BASE/jobs?office=WS-SYD" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jobName":"Should still land in Texas"}')
SNEAKY_OFFICE_CODE=$(echo "$SNEAKY" | jq -r .job.office_id)
check "non-admin office override is ignored (job still tagged to caller's real office)" "$SNEAKY_OFFICE_CODE" "$JOB_A_OFFICE"

echo "=== 7. Cross-office isolation between two ordinary branch staff ==="
SYDNEY_SEES_TEXAS_JOB=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$JOB_A_ID" -H "Authorization: Bearer $SYDNEY_TOKEN")
check "Sydney staff CANNOT fetch Texas's job (404, not leaked)" "$SYDNEY_SEES_TEXAS_JOB" "404"
TEXAS_SEES_OWN_JOB=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$JOB_A_ID" -H "Authorization: Bearer $TEXAS_TOKEN")
check "Texas staff CAN fetch their own job" "$TEXAS_SEES_OWN_JOB" "200"

echo "=== 8. HQ sees jobs from every office (production hub) ==="
INDIA_JOB_COUNT=$(curl -s "$BASE/jobs" -H "Authorization: Bearer $INDIA_TOKEN" | jq '.jobs | length')
check "India/HQ sees at least the 3 jobs just created across offices" "$([ "$INDIA_JOB_COUNT" -ge 3 ] && echo yes)" "yes"

echo "=== 9. Setting-charge guard blocks an unconfirmed semi-mount job ==="
BLOCKED=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$JOB_B_ID/status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"statusCode":"quote_given"}')
check "moving semi-mount job to Quote Given without a setting charge -> 409" "$BLOCKED" "409"

echo "=== 10. Providing the setting charge unblocks it ==="
UNBLOCKED=$(curl -s -X PATCH "$BASE/jobs/$JOB_B_ID/status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"statusCode":"quote_given","settingCharge":"400"}')
UNBLOCKED_STATUS=$(echo "$UNBLOCKED" | jq -r .job.status_code)
UNBLOCKED_CONFIRMED=$(echo "$UNBLOCKED" | jq -r .job.setting_charge_confirmed)
check "status now quote_given" "$UNBLOCKED_STATUS" "quote_given"
check "settingChargeConfirmed is now true" "$UNBLOCKED_CONFIRMED" "true"

echo "=== 11. A normal job (no semi-mount) reaches Quote Given with no prompt needed ==="
NORMAL=$(curl -s -X PATCH "$BASE/jobs/$JOB_A_ID/status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"statusCode":"quote_given"}')
NORMAL_STATUS=$(echo "$NORMAL" | jq -r .job.status_code)
check "job A moved straight to quote_given" "$NORMAL_STATUS" "quote_given"

echo "=== 12. Branch->HQ status sync wrote India's mirrored status ==="
NORMAL_HQ=$(echo "$NORMAL" | jq -r .job.hq_status_code)
check "job A's hq_status_code synced to quote_given" "$NORMAL_HQ" "quote_given"

echo "=== 13. Status history recorded both the create and the status change ==="
HIST_COUNT=$(curl -s "$BASE/jobs/$JOB_A_ID/history" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.history | length')
check "job A has 2 history entries (created + status change)" "$HIST_COUNT" "2"

echo "=== 14. HQ-side status change headlines back to the branch ==="
HQ_CHANGE=$(curl -s -X PATCH "$BASE/jobs/$JOB_A_ID/hq-status" -H "Authorization: Bearer $INDIA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"hqStatusCode":"in_production","productionFields":{"cadIssued":"2026-07-15"}}')
HQ_CHANGE_BRANCH_STATUS=$(echo "$HQ_CHANGE" | jq -r .job.status_code)
check "India setting in_production headlines branch status to production_started" "$HQ_CHANGE_BRANCH_STATUS" "production_started"

echo "=== 15. A branch staffer (not HQ) is refused the HQ-only route ==="
REFUSED=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$JOB_A_ID/hq-status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"hqStatusCode":"in_production"}')
check "Texas staff cannot call the HQ-status route" "$REFUSED" "403"

echo "=== 16. Trying to manually set a system-only status is rejected ==="
SYS_ONLY=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$JOB_A_ID/status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"statusCode":"production_started"}')
check "manually picking Production Started (system-only) -> 400" "$SYS_ONLY" "400"

echo "=== 17. No token at all is rejected ==="
NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs")
check "no Authorization header -> 401" "$NOAUTH" "401"

echo "=== 18. Known inherited quirk: the notes-scan regex has no negation awareness ==="
# Ported as-is from the original app's jobNeedsSettingCharge(). A note that says
# "no client stone" still contains the substring "client stone", so it still
# triggers the guard — same behaviour the legacy Texas app has always had.
# Documented here on purpose so it's a known, verified trait, not a surprise.
QUIRK_JOB=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jobName":"Quirk demo job","notes":"Confirmed: no client stone involved."}')
QUIRK_JOB_ID=$(echo "$QUIRK_JOB" | jq -r .job.id)
QUIRK_BLOCKED=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$QUIRK_JOB_ID/status" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"statusCode":"quote_given"}')
check "\"no client stone\" in notes still triggers the guard (inherited, documented behaviour)" "$QUIRK_BLOCKED" "409"

echo
echo "================================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ]
