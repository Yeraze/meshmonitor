#!/usr/bin/env bash
# Shared helpers for the Automation Engine simulated system tests (#3653).
#
# These exercise POST /api/automations/test — a dry-run that performs NO mesh IO,
# NO Apprise dispatch and NO persistence — so the whole trigger/condition matrix
# can be verified deterministically with no real hardware and no MQTT timing.
#
# Usage (from a test script):
#   source "$(dirname "$0")/lib.sh"
#   ae_login
#   out=$(ae_sim "$CONFIG" "$EVENT" "$NODE" "$VARS")
#   assert_json "$out" '.matched' 'true' 'message trigger matches'
#   ae_summary
#
# Env overrides: API_BASE_URL, API_USER, API_PASS.

set -uo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:8080/meshmonitor}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-changeme}"
COOKIES="$(mktemp)"
CSRF=""
PASS=0
FAIL=0

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required"; exit 2; }

cleanup() { rm -f "$COOKIES"; }
trap cleanup EXIT

ae_login() {
  CSRF=$(curl -s -c "$COOKIES" "$API_BASE_URL/api/csrf-token" | jq -r '.csrfToken // .token // empty')
  local resp
  resp=$(curl -s -b "$COOKIES" -c "$COOKIES" -X POST "$API_BASE_URL/api/auth/login" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
    -d "{\"username\":\"$API_USER\",\"password\":\"$API_PASS\"}")
  if ! echo "$resp" | jq -e '.user // .success // .username' >/dev/null 2>&1; then
    echo "FATAL: login failed for $API_USER@$API_BASE_URL: $resp"; exit 2
  fi
  # refresh CSRF post-login
  CSRF=$(curl -s -b "$COOKIES" -c "$COOKIES" "$API_BASE_URL/api/csrf-token" | jq -r '.csrfToken // .token // empty')
}

# ae_sim CONFIG EVENT [NODE] [VARS] [TELEMETRY] — returns the SimResult JSON.
ae_sim() {
  local config="$1" event="$2" node="${3:-null}" vars="${4:-null}" telem="${5:-null}"
  local body
  body=$(jq -nc --argjson config "$config" --argjson event "$event" \
    --argjson node "$node" --argjson variables "$vars" --argjson telemetry "$telem" \
    '{config:$config, event:$event} + (if $node==null then {} else {node:$node} end)
      + (if $variables==null then {} else {variables:$variables} end)
      + (if $telemetry==null then {} else {telemetry:$telemetry} end)')
  curl -s -b "$COOKIES" -c "$COOKIES" -X POST "$API_BASE_URL/api/automations/test" \
    -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d "$body"
}

# assert_json JSON JQ_FILTER EXPECTED MESSAGE
assert_json() {
  local json="$1" filter="$2" expected="$3" msg="$4" actual
  actual=$(echo "$json" | jq -rc "$filter" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS+1)); echo "  ✓ $msg"
  else
    FAIL=$((FAIL+1)); echo "  ✗ $msg"; echo "      filter:   $filter"; echo "      expected: $expected"; echo "      actual:   $actual"; echo "      payload:  $(echo "$json" | jq -c . 2>/dev/null || echo "$json")"
  fi
}

ae_summary() {
  echo ""
  echo "  Passed: $PASS   Failed: $FAIL"
  [ "$FAIL" -eq 0 ]
}
