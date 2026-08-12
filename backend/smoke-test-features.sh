#!/usr/bin/env bash
# Covers the new features added on top of the original 85-check baseline:
# design entries/client items, SLA alerts, reports, import, Gmail scaffolding.
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

login() { curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo1234\"}" | jq -r .token; }
TEXAS_TOKEN=$(login texas.staff@worldshiner.demo)
SYDNEY_TOKEN=$(login sydney.staff@worldshiner.demo)
ADMIN_TOKEN=$(login admin@worldshiner.demo)

echo "=== Design entries: claim, add, cross-office scoping ==="
JOB_ID=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"jobName":"Feature Suite Job"}' | jq -r .job.id)
CLAIM1=$(curl -s -X POST "$BASE/jobs/$JOB_ID/design-entries/claim-number" -H "Authorization: Bearer $TEXAS_TOKEN" | jq -r .baseNumber)
CLAIM2=$(curl -s -X POST "$BASE/jobs/$JOB_ID/design-entries/claim-number" -H "Authorization: Bearer $TEXAS_TOKEN" | jq -r .baseNumber)
[ "$CLAIM1" != "$CLAIM2" ] && echo "  ✅ sequential claim numbers differ" && PASS=$((PASS+1)) || { echo "  ❌ claim numbers not sequential"; FAIL=$((FAIL+1)); }
ENTRY=$(curl -s -X POST "$BASE/jobs/$JOB_ID/design-entries" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d "{\"kind\":\"matching_set\",\"baseNumber\":\"$CLAIM1\",\"suffix\":\"E\"}" | jq -r .entry.base_number)
check "matching set formats as base+suffix-S" "$ENTRY" "${CLAIM1}E-S"
SYD_403=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$JOB_ID/design-entries" -H "Authorization: Bearer $SYDNEY_TOKEN")
check "cross-office design-entries read blocked" "$SYD_403" "404"
CI_403=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$JOB_ID/client-items" -H "Authorization: Bearer $SYDNEY_TOKEN")
check "cross-office client-items read blocked" "$CI_403" "404"

echo "=== SLA alerts: office scoping ==="
psql_cmd() { PGPASSWORD=postgres "/c/Program Files/PostgreSQL/17/bin/psql" -U postgres -h localhost -p 5433 -d worldshiner2 -t -c "$1"; }
psql_cmd "UPDATE job_status_history SET changed_at = now() - interval '30 hours' WHERE job_id = $JOB_ID AND status_code = 'quoting';" > /dev/null
TEXAS_BREACH=$(curl -s "$BASE/sla/breaches" -H "Authorization: Bearer $TEXAS_TOKEN" | jq --arg id "$JOB_ID" '[.breaches[] | select(.jobId==$id)] | length')
check "Texas staff sees their own SLA breach" "$TEXAS_BREACH" "1"
SYD_BREACH=$(curl -s "$BASE/sla/breaches" -H "Authorization: Bearer $SYDNEY_TOKEN" | jq --arg id "$JOB_ID" '[.breaches[] | select(.jobId==$id)] | length')
check "Sydney staff does NOT see Texas's SLA breach" "$SYD_BREACH" "0"

echo "=== Reports: JSON summary and PDF ==="
YEAR=$(date +%Y); MONTH=$(date +%-m)
REP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/reports/monthly-summary?year=$YEAR&month=$MONTH" -H "Authorization: Bearer $ADMIN_TOKEN")
check "monthly summary JSON returns 200" "$REP_STATUS" "200"
PDF_MAGIC=$(curl -s "$BASE/reports/monthly-summary/pdf?year=$YEAR&month=$MONTH" -H "Authorization: Bearer $ADMIN_TOKEN" | head -c 4)
check "PDF starts with %PDF magic bytes" "$PDF_MAGIC" "%PDF"

echo "=== Import: preview, commit, dedup ==="
CSV_B64=$(printf 'Job Title,PO Number\nFeature Suite Import,FS-IMP-001\n' | base64 -w0)
DATAURL="data:text/csv;base64,$CSV_B64"
PREVIEW_BODY=$(jq -n --arg d "$DATAURL" '{fileDataUrl:$d, filename:"t.csv"}')
PREVIEW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/import/preview" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$PREVIEW_BODY")
check "import preview returns 200" "$PREVIEW_STATUS" "200"
COMMIT_BODY=$(jq -n --arg d "$DATAURL" '{fileDataUrl:$d, filename:"t.csv", mapping:{"0":"jobName","1":"poNumber"}, officeCode:"DM-USA"}')
FIRST_IMPORTED=$(curl -s -X POST "$BASE/import/commit" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$COMMIT_BODY" | jq -r .imported)
check "first import inserts the row" "$FIRST_IMPORTED" "1"
SECOND_SKIPPED=$(curl -s -X POST "$BASE/import/commit" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "$COMMIT_BODY" | jq -r .skippedDuplicate)
check "re-import of same PO is skipped as duplicate" "$SECOND_SKIPPED" "1"
IMPORT_NON_ADMIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/import/preview" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d "$PREVIEW_BODY")
check "ordinary staff cannot use import -> 403" "$IMPORT_NON_ADMIN" "403"

echo "=== Gmail: graceful no-config behaviour ==="
GMAIL_STATUS=$(curl -s "$BASE/gmail/status" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r .configured)
check "gmail status reports not configured, doesn't crash" "$GMAIL_STATUS" "false"
GMAIL_CONNECT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/gmail/connect" -H "Authorization: Bearer $ADMIN_TOKEN")
check "gmail connect returns 501 when unconfigured" "$GMAIL_CONNECT" "501"

echo ""
echo "================================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ]
