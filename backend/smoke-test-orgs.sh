#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:4000/api
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  ✅ $desc"; PASS=$((PASS+1));
  else echo "  ❌ $desc — expected [$want] got [$got]"; FAIL=$((FAIL+1)); fi
}
login() { curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo1234\"}" | jq -r .token; }

SUPER=$(login admin@worldshiner.demo)
DIACROWN_ORGADMIN=$(login diacrown.orgadmin@worldshiner.demo)
DIACROWN_HQ=$(login india.staff@worldshiner.demo)
TEXAS=$(login texas.staff@worldshiner.demo)
DIAMORE_HQ=$(login diamore.staff@worldshiner.demo)
DIAMORE_LOC=$(login diamore.location.staff@worldshiner.demo)

echo "=== Office visibility respects org boundaries ==="
SUPER_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $SUPER" | jq '.offices | length')
check "super admin sees all 12 offices (both orgs)" "$SUPER_OFFICES" "12"
DIACROWN_ADMIN_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $DIACROWN_ORGADMIN" | jq '.offices | length')
check "Diacrown org admin sees only Diacrown's 10 offices" "$DIACROWN_ADMIN_OFFICES" "10"
DIACROWN_HQ_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $DIACROWN_HQ" | jq '.offices | length')
check "Diacrown HQ staff (not org admin) also sees only Diacrown's 10 offices" "$DIACROWN_HQ_OFFICES" "10"
DIAMORE_HQ_OFFICES=$(curl -s "$BASE/offices" -H "Authorization: Bearer $DIAMORE_HQ" | jq '.offices | length')
check "Diamore HQ staff sees only Diamore's 2 offices, NOT Diacrown's" "$DIAMORE_HQ_OFFICES" "2"

echo "=== Jobs: Diamore location creates a job ==="
DM_JOB=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $DIAMORE_LOC" -H 'Content-Type: application/json' -d '{"jobName":"Diamore test job"}')
DM_JOB_ID=$(echo "$DM_JOB" | jq -r .job.id)
check "Diamore location job created" "$([ -n "$DM_JOB_ID" ] && [ "$DM_JOB_ID" != "null" ] && echo yes)" "yes"

echo "=== Diacrown HQ CANNOT see Diamore's job (the core fix) ==="
DIACROWN_SEES_DIAMORE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$DM_JOB_ID" -H "Authorization: Bearer $DIACROWN_HQ")
check "Diacrown HQ blocked from Diamore's job -> 404" "$DIACROWN_SEES_DIAMORE" "404"
TEXAS_SEES_DIAMORE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$DM_JOB_ID" -H "Authorization: Bearer $TEXAS")
check "Texas (Diacrown branch) also blocked from Diamore's job -> 404" "$TEXAS_SEES_DIAMORE" "404"
DIAMORE_SEES_OWN=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$DM_JOB_ID" -H "Authorization: Bearer $DIAMORE_HQ")
check "Diamore HQ CAN see its own org's job" "$DIAMORE_SEES_OWN" "200"

echo "=== Super admin sees across both orgs ==="
SUPER_SEES_DIAMORE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$DM_JOB_ID" -H "Authorization: Bearer $SUPER")
check "Super admin CAN see Diamore's job" "$SUPER_SEES_DIAMORE" "200"

echo "=== Job list scoping ==="
TEXAS_JOB=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS" -H 'Content-Type: application/json' -d '{"jobName":"Texas test job"}')
DIAMORE_LIST=$(curl -s "$BASE/jobs" -H "Authorization: Bearer $DIAMORE_HQ" | jq '[.jobs[] | select(.office_code=="DM-USA")] | length')
check "Diamore's job list contains zero Texas (Diacrown) jobs" "$DIAMORE_LIST" "0"

echo "=== HQ-status route respects org boundary (the gap found and fixed mid-build) ==="
DIAMORE_TOUCHES_DIACROWN_JOB=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$(echo $TEXAS_JOB | jq -r .job.id)/hq-status" -H "Authorization: Bearer $DIAMORE_HQ" -H 'Content-Type: application/json' -d '{"hqStatusCode":"in_production"}')
check "Diamore HQ cannot set HQ-status on a Diacrown job -> 403" "$DIAMORE_TOUCHES_DIACROWN_JOB" "403"
DIACROWN_TOUCHES_OWN=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$(echo $TEXAS_JOB | jq -r .job.id)/hq-status" -H "Authorization: Bearer $DIACROWN_HQ" -H 'Content-Type: application/json' -d '{"hqStatusCode":"in_production"}')
check "Diacrown HQ CAN set HQ-status on its own org's job" "$DIACROWN_TOUCHES_OWN" "200"

echo "=== Staff management respects org boundaries ==="
DIACROWN_STAFF_LIST=$(curl -s "$BASE/users" -H "Authorization: Bearer $DIACROWN_ORGADMIN" | jq '[.users[] | select(.org_code=="DIAMORE")] | length')
check "Diacrown org admin's staff list contains zero Diamore staff" "$DIACROWN_STAFF_LIST" "0"

CROSS_ORG_ADD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/users" -H "Authorization: Bearer $DIACROWN_ORGADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"sneaky@example.com","password":"password123","displayName":"Sneaky","officeCode":"DM-HQ"}')
check "Diacrown org admin cannot add staff to a Diamore office -> 403" "$CROSS_ORG_ADD" "403"

GLOBAL_ADMIN_GRANT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/users" -H "Authorization: Bearer $DIACROWN_ORGADMIN" -H 'Content-Type: application/json' \
  -d '{"email":"poweruser@example.com","password":"password123","displayName":"X","officeCode":"HQ","isGlobalAdmin":true}')
check "Org admin cannot grant global admin rights, even in their own org -> 403" "$GLOBAL_ADMIN_GRANT" "403"

echo "=== Invite codes respect org boundaries ==="
CROSS_ORG_INVITE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invite-codes" -H "Authorization: Bearer $DIACROWN_ORGADMIN" -H 'Content-Type: application/json' -d '{"officeCode":"DM-HQ"}')
check "Diacrown org admin cannot create an invite for a Diamore office -> 403" "$CROSS_ORG_INVITE" "403"
OWN_ORG_INVITE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invite-codes" -H "Authorization: Bearer $DIACROWN_ORGADMIN" -H 'Content-Type: application/json' -d '{"officeCode":"WS-SYD"}')
check "Diacrown org admin CAN create an invite within their own org" "$OWN_ORG_INVITE" "201"

DIAMORE_INVITE_LIST=$(curl -s "$BASE/invite-codes" -H "Authorization: Bearer $DIAMORE_HQ" 2>/dev/null || echo '{"invites":[]}')
# diamore.staff isn't an org admin, so this should 403 - check that instead
DIAMORE_NONADMIN_LIST=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/invite-codes" -H "Authorization: Bearer $DIAMORE_HQ")
check "Ordinary HQ staff (not org admin) cannot list invite codes -> 403" "$DIAMORE_NONADMIN_LIST" "403"

echo
echo "================================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ]
