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
TEXAS_TOKEN=$(login texas.staff@worldshiner.demo)
INDIA_TOKEN=$(login india.staff@worldshiner.demo)
SYDNEY_TOKEN=$(login sydney.staff@worldshiner.demo)

echo "=== Job edit ==="
JOB=$(curl -s -X POST "$BASE/jobs" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"jobName":"Edit test job","priority":"Low"}')
JOB_ID=$(echo "$JOB" | jq -r .job.id)
EDITED=$(curl -s -X PATCH "$BASE/jobs/$JOB_ID" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"priority":"High","poNumber":"PO-9001"}')
check "priority updated via edit" "$(echo "$EDITED" | jq -r .job.priority)" "High"
check "PO number updated via edit" "$(echo "$EDITED" | jq -r .job.po_number)" "PO-9001"
NOSTATUS=$(echo "$EDITED" | jq -r .job.status_code)
check "edit endpoint does not touch status" "$NOSTATUS" "quoting"

echo "=== Cross-office: Sydney cannot edit Texas's job ==="
FORBIDDEN=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/jobs/$JOB_ID" -H "Authorization: Bearer $SYDNEY_TOKEN" -H 'Content-Type: application/json' -d '{"priority":"Low"}')
check "Sydney editing Texas's job -> 404 (not leaked, not modified)" "$FORBIDDEN" "404"
STILL_HIGH=$(curl -s "$BASE/jobs/$JOB_ID" -H "Authorization: Bearer $TEXAS_TOKEN" | jq -r .job.priority)
check "job priority unchanged after the blocked attempt" "$STILL_HIGH" "High"

echo "=== Issue tracker ==="
ISSUE=$(curl -s -X POST "$BASE/jobs/$JOB_ID/issues" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"issueType":"Repair","description":"Prong came loose after sizing"}')
ISSUE_ID=$(echo "$ISSUE" | jq -r .issue.id)
check "issue created with open status" "$(echo "$ISSUE" | jq -r .issue.status)" "open"
LIST=$(curl -s "$BASE/jobs/$JOB_ID/issues" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.issues | length')
check "job has 1 issue listed" "$LIST" "1"
RESOLVED=$(curl -s -X PATCH "$BASE/issues/$ISSUE_ID" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"action":"resolve","note":"Re-set and returned to client"}')
check "issue resolved" "$(echo "$RESOLVED" | jq -r .issue.status)" "resolved"
REOPENED=$(curl -s -X PATCH "$BASE/issues/$ISSUE_ID" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"action":"reopen"}')
check "issue reopened" "$(echo "$REOPENED" | jq -r .issue.status)" "open"
EVENTS=$(curl -s "$BASE/issues/$ISSUE_ID/events" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.events | length')
check "issue has 3 history events (opened, resolved, reopened)" "$EVENTS" "3"

echo "=== Job chat ==="
MSG=$(curl -s -X POST "$BASE/jobs/$JOB_ID/chat" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"body":"Can India confirm the ship date?"}')
check "chat message sent" "$(echo "$MSG" | jq -r .message.body)" "Can India confirm the ship date?"
REPLY=$(curl -s -X POST "$BASE/jobs/$JOB_ID/chat" -H "Authorization: Bearer $INDIA_TOKEN" -H 'Content-Type: application/json' -d '{"body":"Shipping Friday."}')
check "India can reply (cross-office, HQ visibility)" "$(echo "$REPLY" | jq -r .message.body)" "Shipping Friday."
THREAD=$(curl -s "$BASE/jobs/$JOB_ID/chat" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.messages | length')
check "thread has 2 messages" "$THREAD" "2"

UNREAD_BEFORE=$(curl -s "$BASE/chat/unread-counts" -H "Authorization: Bearer $TEXAS_TOKEN" | jq --arg id "$JOB_ID" '.unread[] | select(.job_id|tostring==$id) | .unread')
check "Texas has 1 unread (India's reply)" "$UNREAD_BEFORE" "1"
curl -s -X POST "$BASE/jobs/$JOB_ID/chat/read" -H "Authorization: Bearer $TEXAS_TOKEN" > /dev/null
UNREAD_AFTER=$(curl -s "$BASE/chat/unread-counts" -H "Authorization: Bearer $TEXAS_TOKEN" | jq --arg id "$JOB_ID" '[.unread[] | select(.job_id|tostring==$id)] | length')
check "marking read clears the unread entry" "$UNREAD_AFTER" "0"

echo "=== Sydney cannot read Texas's job chat ==="
CHAT_FORBIDDEN=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/jobs/$JOB_ID/chat" -H "Authorization: Bearer $SYDNEY_TOKEN")
check "Sydney blocked from Texas's job chat -> 404" "$CHAT_FORBIDDEN" "404"

echo "=== Image upload ==="
# 1x1 transparent PNG, base64-encoded
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
UPLOAD=$(curl -s -X POST "$BASE/uploads" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d "{\"dataUrl\":\"data:image/png;base64,$PNG_B64\"}")
IMG_URL=$(echo "$UPLOAD" | jq -r .url)
check "upload returned an http(s) url" "$(echo "$IMG_URL" | grep -c '^http')" "1"
FETCH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$IMG_URL")
check "uploaded image is actually servable" "$FETCH_CODE" "200"

ATTACH=$(curl -s -X POST "$BASE/jobs/$JOB_ID/images" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d "{\"kind\":\"cad\",\"url\":\"$IMG_URL\"}")
IMG_ID=$(echo "$ATTACH" | jq -r .image.id)
check "image attached to job" "$(echo "$ATTACH" | jq -r .image.kind)" "cad"
IMG_LIST=$(curl -s "$BASE/jobs/$JOB_ID/images" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.images | length')
check "job shows 1 attached image" "$IMG_LIST" "1"
curl -s -X DELETE "$BASE/jobs/$JOB_ID/images/$IMG_ID" -H "Authorization: Bearer $TEXAS_TOKEN" > /dev/null
IMG_LIST_AFTER=$(curl -s "$BASE/jobs/$JOB_ID/images" -H "Authorization: Bearer $TEXAS_TOKEN" | jq '.images | length')
check "image removed from job after delete" "$IMG_LIST_AFTER" "0"

echo "=== Reject an oversized/invalid upload ==="
BAD_TYPE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/uploads" -H "Authorization: Bearer $TEXAS_TOKEN" -H 'Content-Type: application/json' -d '{"dataUrl":"data:text/plain;base64,aGVsbG8="}')
check "non-image upload rejected" "$BAD_TYPE" "400"

echo
echo "================================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ]
