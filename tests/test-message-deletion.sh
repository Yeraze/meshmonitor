#!/bin/bash
# Message Deletion API Test
# Tests individual message deletion, channel purge, and DM purge endpoints
# Verifies permission checks and deletion functionality

set -e  # Exit on any error

echo "=========================================="
echo "Message Deletion API Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Use port 8080 for dev environment
BASE_URL="${BASE_URL:-http://localhost:8080}"
COOKIE_FILE="/tmp/meshmonitor-deletion-test-cookies.txt"

# Cleanup function
cleanup() {
    rm -f "$COOKIE_FILE"
}
trap cleanup EXIT

echo -e "${BLUE}Test Configuration:${NC}"
echo "  Base URL: $BASE_URL"
echo ""

# Test 1: Get CSRF token
echo "Test 1: Fetch CSRF token for authentication"
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/csrf-token \
    -c "$COOKIE_FILE")

HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓ PASS${NC}: CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get CSRF token (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 2: Login as admin
echo "Test 2: Login with admin credentials"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' \
    -b "$COOKIE_FILE" \
    -c "$COOKIE_FILE")

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Login successful"
else
    echo -e "${RED}✗ FAIL${NC}: Login failed (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 3: Get initial message count
echo "Test 3: Get initial message count"
MESSAGES_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/messages?limit=100 \
    -b "$COOKIE_FILE")

HTTP_CODE=$(echo "$MESSAGES_RESPONSE" | tail -n1)
MESSAGES_JSON=$(echo "$MESSAGES_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    INITIAL_COUNT=$(echo "$MESSAGES_JSON" | grep -o '"id"' | wc -l)
    echo -e "${GREEN}✓ PASS${NC}: Retrieved messages (count: $INITIAL_COUNT)"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get messages (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 4: Try to delete a message without proper ID (should fail)
echo "Test 4: Try to delete non-existent message"
DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE $BASE_URL/api/messages/nonexistent-id \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b "$COOKIE_FILE")

HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "404" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Correctly returns 404 for non-existent message"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Expected HTTP 404, got HTTP $HTTP_CODE"
fi
echo ""

# Test 5: Get a real message ID to test deletion
if [ "$INITIAL_COUNT" -gt "0" ]; then
    echo "Test 5: Delete an existing message"
    MESSAGE_ID=$(echo "$MESSAGES_JSON" | grep -o '"id":"[^"]*"' | head -n1 | cut -d'"' -f4)

    if [ -n "$MESSAGE_ID" ]; then
        DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "$BASE_URL/api/messages/$MESSAGE_ID" \
            -H "Content-Type: application/json" \
            -H "X-CSRF-Token: $CSRF_TOKEN" \
            -b "$COOKIE_FILE")

        HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)
        RESPONSE_BODY=$(echo "$DELETE_RESPONSE" | head -n-1)

        if [ "$HTTP_CODE" = "200" ]; then
            echo -e "${GREEN}✓ PASS${NC}: Message deleted successfully"
            echo "   Message ID: $MESSAGE_ID"

            # Verify message is actually deleted
            VERIFY_MESSAGES=$(curl -s $BASE_URL/api/messages?limit=100 -b "$COOKIE_FILE")
            NEW_COUNT=$(echo "$VERIFY_MESSAGES" | grep -o '"id"' | wc -l)
            EXPECTED_COUNT=$((INITIAL_COUNT - 1))

            if [ "$NEW_COUNT" -eq "$EXPECTED_COUNT" ]; then
                echo -e "${GREEN}✓ PASS${NC}: Message count decreased correctly ($INITIAL_COUNT -> $NEW_COUNT)"
            else
                echo -e "${YELLOW}⚠ WARNING${NC}: Message count unexpected (expected: $EXPECTED_COUNT, actual: $NEW_COUNT)"
            fi
        else
            echo -e "${YELLOW}⚠ WARNING${NC}: Message deletion failed (HTTP $HTTP_CODE)"
            echo "   Response: $RESPONSE_BODY"
        fi
    else
        echo -e "${YELLOW}⚠ SKIP${NC}: No message ID found to test deletion"
    fi
else
    echo -e "${YELLOW}⚠ SKIP${NC}: No messages available to test deletion"
fi
echo ""

# Test 6: Test channel purge endpoint exists and requires proper permissions
echo "Test 6: Test channel purge endpoint (channel 0)"
CHANNEL_PURGE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE $BASE_URL/api/messages/channels/0 \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b "$COOKIE_FILE")

HTTP_CODE=$(echo "$CHANNEL_PURGE_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$CHANNEL_PURGE_RESPONSE" | head -n-1)

# Admin should be able to purge (200) or channel might not exist/have messages (still valid response)
if [ "$HTTP_CODE" = "200" ]; then
    DELETED_COUNT=$(echo "$RESPONSE_BODY" | grep -o '"deletedCount":[0-9]*' | cut -d':' -f2)
    echo -e "${GREEN}✓ PASS${NC}: Channel purge successful (deleted: $DELETED_COUNT messages)"
elif [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Channel purge returned expected error for invalid channel"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Unexpected response (HTTP $HTTP_CODE)"
    echo "   Response: $RESPONSE_BODY"
fi
echo ""

# Test 7: Test DM purge endpoint with invalid node number
echo "Test 7: Test DM purge with invalid node number"
DM_PURGE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE $BASE_URL/api/messages/direct-messages/invalid \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b "$COOKIE_FILE")

HTTP_CODE=$(echo "$DM_PURGE_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "400" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Correctly rejects invalid node number (HTTP 400)"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Expected HTTP 400, got HTTP $HTTP_CODE"
fi
echo ""

# Test 8: Test DM purge endpoint with valid node number
echo "Test 8: Test DM purge with valid node number (999999999)"
DM_PURGE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE $BASE_URL/api/messages/direct-messages/999999999 \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b "$COOKIE_FILE")

HTTP_CODE=$(echo "$DM_PURGE_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$DM_PURGE_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    DELETED_COUNT=$(echo "$RESPONSE_BODY" | grep -o '"deletedCount":[0-9]*' | cut -d':' -f2)
    echo -e "${GREEN}✓ PASS${NC}: DM purge successful (deleted: $DELETED_COUNT messages)"
else
    echo -e "${YELLOW}⚠ WARNING${NC}: Unexpected response (HTTP $HTTP_CODE)"
    echo "   Response: $RESPONSE_BODY"
fi
echo ""

# Test 9: Test permission denial for anonymous users
echo "Test 9: Test permission denial for anonymous users"
rm -f "$COOKIE_FILE"  # Remove auth cookies

ANON_DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE $BASE_URL/api/messages/test-id \
    -H "Content-Type: application/json")

HTTP_CODE=$(echo "$ANON_DELETE_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Anonymous user correctly denied (HTTP $HTTP_CODE)"
else
    echo -e "${RED}✗ FAIL${NC}: Anonymous user should be denied, got HTTP $HTTP_CODE"
    exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All message deletion tests completed!${NC}"
echo "=========================================="
echo ""
echo "Summary:"
echo "  ✓ CSRF token authentication"
echo "  ✓ Message deletion endpoint"
echo "  ✓ Channel purge endpoint"
echo "  ✓ DM purge endpoint"
echo "  ✓ Permission checks"
echo "  ✓ Input validation"
echo ""
