#!/bin/bash
# API Testing Helper Script
# Usage:
#   ./scripts/api-test.sh login              # Login and store session
#   ./scripts/api-test.sh get /api/endpoint  # Make authenticated GET request
#   ./scripts/api-test.sh post /api/endpoint '{"data":"value"}'  # POST request
#   ./scripts/api-test.sh delete /api/endpoint  # DELETE request
#
# Environment variables:
#   API_BASE_URL - Base URL (default: http://localhost:8081/meshmonitor)
#   API_USER - Username (default: admin)
#   API_PASS - Password (default: changeme1)

set -e

COOKIE_FILE="/tmp/meshmonitor-api-cookies.txt"
CSRF_FILE="/tmp/meshmonitor-csrf-token.txt"
API_BASE_URL="${API_BASE_URL:-http://localhost:8081/meshmonitor}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-changeme1}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

get_csrf_token() {
    local response
    response=$(curl -s -c "$COOKIE_FILE" "${API_BASE_URL}/api/csrf-token")
    local token
    token=$(echo "$response" | jq -r '.csrfToken // empty')
    if [ -z "$token" ]; then
        echo -e "${RED}Failed to get CSRF token${NC}" >&2
        echo "$response" >&2
        return 1
    fi
    echo "$token" > "$CSRF_FILE"
    echo "$token"
}

do_login() {
    echo -e "${YELLOW}Getting CSRF token...${NC}" >&2
    local csrf
    csrf=$(get_csrf_token)
    if [ $? -ne 0 ]; then
        return 1
    fi

    echo -e "${YELLOW}Logging in as ${API_USER}...${NC}" >&2
    local response
    response=$(curl -s -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
        -X POST "${API_BASE_URL}/api/auth/login" \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: $csrf" \
        -d "{\"username\":\"${API_USER}\",\"password\":\"${API_PASS}\"}")

    local username
    username=$(echo "$response" | jq -r '.user.username // empty')
    if [ -z "$username" ]; then
        echo -e "${RED}Login failed${NC}" >&2
        echo "$response" | jq . 2>/dev/null || echo "$response" >&2
        return 1
    fi

    echo -e "${GREEN}Logged in as: ${username}${NC}" >&2
    echo "$response" | jq .
}

ensure_logged_in() {
    # Check if we have a valid session
    if [ ! -f "$COOKIE_FILE" ] || [ ! -f "$CSRF_FILE" ]; then
        do_login > /dev/null
        return $?
    fi

    # Verify session is still valid
    local csrf
    csrf=$(cat "$CSRF_FILE")
    local response
    response=$(curl -s -b "$COOKIE_FILE" "${API_BASE_URL}/api/auth/me" 2>/dev/null)
    local username
    username=$(echo "$response" | jq -r '.user.username // empty' 2>/dev/null)

    if [ -z "$username" ]; then
        echo -e "${YELLOW}Session expired, re-logging in...${NC}" >&2
        do_login > /dev/null
        return $?
    fi
    return 0
}

api_request() {
    local method="$1"
    local endpoint="$2"
    local data="$3"

    ensure_logged_in || return 1

    local csrf
    csrf=$(cat "$CSRF_FILE")

    local curl_args=(-s -b "$COOKIE_FILE" -c "$COOKIE_FILE")
    curl_args+=(-X "$method")
    curl_args+=(-H "X-CSRF-Token: $csrf")

    if [ -n "$data" ]; then
        curl_args+=(-H "Content-Type: application/json")
        curl_args+=(-d "$data")
    fi

    local url="${API_BASE_URL}${endpoint}"
    curl "${curl_args[@]}" "$url"
}

# Main command handling
case "${1:-help}" in
    login)
        do_login
        ;;
    get|GET)
        api_request GET "$2" | jq . 2>/dev/null || api_request GET "$2"
        ;;
    post|POST)
        api_request POST "$2" "$3" | jq . 2>/dev/null || api_request POST "$2" "$3"
        ;;
    put|PUT)
        api_request PUT "$2" "$3" | jq . 2>/dev/null || api_request PUT "$2" "$3"
        ;;
    delete|DELETE)
        api_request DELETE "$2" | jq . 2>/dev/null || api_request DELETE "$2"
        ;;
    logout)
        rm -f "$COOKIE_FILE" "$CSRF_FILE"
        echo -e "${GREEN}Logged out (cookies cleared)${NC}"
        ;;
    help|--help|-h|*)
        echo "MeshMonitor API Testing Helper"
        echo ""
        echo "Usage:"
        echo "  $0 login                          # Login and store session"
        echo "  $0 get /api/endpoint              # Make authenticated GET request"
        echo "  $0 post /api/endpoint '{\"key\":\"value\"}'  # POST request"
        echo "  $0 put /api/endpoint '{\"key\":\"value\"}'   # PUT request"
        echo "  $0 delete /api/endpoint           # DELETE request"
        echo "  $0 logout                         # Clear stored session"
        echo ""
        echo "Environment variables:"
        echo "  API_BASE_URL  Base URL (default: http://localhost:8081/meshmonitor)"
        echo "  API_USER      Username (default: admin)"
        echo "  API_PASS      Password (default: changeme)"
        echo ""
        echo "Examples:"
        echo "  $0 get /api/packets/stats"
        echo "  $0 get /api/packets/stats/distribution"
        echo "  $0 get '/api/packets/stats/distribution?since=1234567890'"
        echo "  API_PASS=changeme1 $0 login"
        ;;
esac
