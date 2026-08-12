#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:4000/api
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then echo "  ✅ $desc"; PASS=$((PASS+1));
  else echo "  ❌ $desc — expected [$want] got [$got]"; FAIL=$((FAIL+1)); fi
}
login() { curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
ADMIN_TOKEN=$(login admin@worldshiner.demo demo1234 | jq -r .token)

echo "=== Sign up with no invite code is rejected ==="
NO_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"newperson@example.com","password":"password123","displayName":"New Person"}')
check "signup with no inviteCode -> 400" "$NO_CODE" "400"

echo "=== Sign up with a bogus invite code is rejected ==="
BOGUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"newperson@example.com","password":"password123","displayName":"New Person","inviteCode":"NOT-REAL"}')
check "signup with invalid inviteCode -> 400" "$BOGUS" "400"

echo "=== Sign up with the seeded demo invite works end-to-end ==="
SIGNUP=$(curl -s -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"newperson@example.com","password":"password123","displayName":"New Person","inviteCode":"demo-join"}')
NEW_TOKEN=$(echo "$SIGNUP" | jq -r .token)
check "signup returns a usable token" "$([ "$NEW_TOKEN" != "null" ] && [ -n "$NEW_TOKEN" ] && echo yes)" "yes"
check "invite code matching is case-insensitive (lowercase worked)" "$(echo "$SIGNUP" | jq -r .user.officeCode)" "HQ"
check "new user got the office the invite grants (HQ), not global admin" "$(echo "$SIGNUP" | jq -r .user.isGlobalAdmin)" "false"

echo "=== The new account can immediately log in ==="
RELOGIN=$(login newperson@example.com password123)
check "re-login with the just-created account works" "$([ "$(echo "$RELOGIN" | jq -r .token)" != "null" ] && echo yes)" "yes"

echo "=== Signing up again with the same email is rejected ==="
DUPE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"newperson@example.com","password":"password123","displayName":"Dupe","inviteCode":"DEMO-JOIN"}')
check "duplicate email signup -> 409" "$DUPE" "409"

echo "=== Password too short is rejected ==="
SHORT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d '{"email":"another@example.com","password":"short","displayName":"X","inviteCode":"DEMO-JOIN"}')
check "signup with <8 char password -> 400" "$SHORT" "400"

echo "=== Admin creates a single-use, office-scoped, expiring invite ==="
FUTURE=$(node -e "console.log(new Date(Date.now()+3600000).toISOString())")
NEWINV=$(curl -s -X POST "$BASE/invite-codes" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"officeCode\":\"DM-USA\",\"maxUses\":1,\"expiresAt\":\"$FUTURE\"}")
INV_CODE=$(echo "$NEWINV" | jq -r .invite.code)
check "invite created with an auto-generated code" "$([ -n "$INV_CODE" ] && [ "$INV_CODE" != "null" ] && echo yes)" "yes"

echo "=== That invite works exactly once ==="
FIRST_USE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"onetime@example.com\",\"password\":\"password123\",\"displayName\":\"One Time\",\"inviteCode\":\"$INV_CODE\"}")
check "first use of the single-use invite succeeds" "$FIRST_USE" "201"
SECOND_USE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"another2@example.com\",\"password\":\"password123\",\"displayName\":\"Another\",\"inviteCode\":\"$INV_CODE\"}")
check "second use of the same single-use invite is rejected" "$SECOND_USE" "400"

echo "=== A non-admin cannot create invite codes ==="
STAFF_TOKEN=$(login texas.staff@worldshiner.demo demo1234 | jq -r .token)
FORBIDDEN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/invite-codes" -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' -d '{"officeCode":"HQ"}')
check "ordinary staff cannot create invite codes -> 403" "$FORBIDDEN" "403"

echo "=== Revoking an invite makes it unusable ==="
REVOKE_TARGET=$(curl -s -X POST "$BASE/invite-codes" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"officeCode":"HQ"}')
REVOKE_ID=$(echo "$REVOKE_TARGET" | jq -r .invite.id)
REVOKE_CODE=$(echo "$REVOKE_TARGET" | jq -r .invite.code)
curl -s -X PATCH "$BASE/invite-codes/$REVOKE_ID/revoke" -H "Authorization: Bearer $ADMIN_TOKEN" > /dev/null
AFTER_REVOKE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/signup" -H 'Content-Type: application/json' \
  -d "{\"email\":\"revoked@example.com\",\"password\":\"password123\",\"displayName\":\"X\",\"inviteCode\":\"$REVOKE_CODE\"}")
check "revoked invite can no longer be used -> 400" "$AFTER_REVOKE" "400"

echo "=== Self-service password change ==="
CHANGE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/auth/password" -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"currentPassword":"demo1234","newPassword":"newpassword456"}')
check "password change with correct current password -> 200" "$CHANGE" "200"
OLD_PW_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"email":"texas.staff@worldshiner.demo","password":"demo1234"}')
check "old password no longer works" "$OLD_PW_LOGIN" "401"
NEW_PW_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"email":"texas.staff@worldshiner.demo","password":"newpassword456"}')
check "new password works" "$NEW_PW_LOGIN" "200"

echo "=== Wrong current password is rejected ==="
NEW_STAFF_TOKEN=$(login texas.staff@worldshiner.demo newpassword456 | jq -r .token)
WRONG_CURRENT=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/auth/password" -H "Authorization: Bearer $NEW_STAFF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"currentPassword":"totally-wrong","newPassword":"whatever123"}')
check "wrong current password -> 401" "$WRONG_CURRENT" "401"

echo "=== Admin can reset another user's password directly ==="
SYDNEY_ID=$(curl -s "$BASE/users" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.users[] | select(.email=="sydney.staff@worldshiner.demo") | .id')
ADMIN_RESET=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/users/$SYDNEY_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"newPassword":"resetbyadmin1"}')
check "admin resets Sydney staff's password -> 200" "$ADMIN_RESET" "200"
RESET_LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"email":"sydney.staff@worldshiner.demo","password":"resetbyadmin1"}')
check "Sydney staff can log in with the admin-reset password" "$RESET_LOGIN" "200"

echo
echo "================================================"
echo "RESULTS: $PASS passed, $FAIL failed"
echo "================================================"
[ "$FAIL" -eq 0 ]
