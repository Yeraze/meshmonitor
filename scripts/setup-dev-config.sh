#!/bin/bash
# Setup Default Dev/Test Configuration
#
# Seeds a fresh MeshMonitor instance with a reasonable default test configuration:
#   - Two sources (Sentry + Sandbox) connected via TCP
#   - Auto-acknowledge enabled on the gauntlet channel for each source
#   - Packet monitor enabled
#
# Usage:
#   ./scripts/setup-dev-config.sh              # Uses defaults
#   SOURCE1_HOST=192.168.5.106 ./scripts/setup-dev-config.sh  # Override source 1 host
#
# Environment variables:
#   API_BASE_URL     - Base URL (default: http://localhost:8081/meshmonitor)
#   API_USER         - Username (default: admin)
#   API_PASS         - Password (default: changeme1)
#   SOURCE1_NAME     - Source 1 name (default: Sentry)
#   SOURCE1_HOST     - Source 1 TCP host (default: 192.168.5.106)
#   SOURCE1_PORT     - Source 1 TCP port (default: 4403)
#   SOURCE1_GAUNTLET - Source 1 gauntlet channel index (default: 7)
#   SOURCE2_NAME     - Source 2 name (default: Sandbox)
#   SOURCE2_HOST     - Source 2 TCP host (default: host.docker.internal)
#   SOURCE2_PORT     - Source 2 TCP port (default: 4404)
#   SOURCE2_GAUNTLET - Source 2 gauntlet channel index (default: 2)
#   SKIP_SOURCES     - Set to "true" to skip source creation (just configure settings)

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

API_BASE_URL="${API_BASE_URL:-http://localhost:8081/meshmonitor}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-changeme1}"

SOURCE1_NAME="${SOURCE1_NAME:-Sentry}"
SOURCE1_HOST="${SOURCE1_HOST:-192.168.5.106}"
SOURCE1_PORT="${SOURCE1_PORT:-4403}"
SOURCE1_GAUNTLET="${SOURCE1_GAUNTLET:-7}"

SOURCE2_NAME="${SOURCE2_NAME:-Sandbox}"
SOURCE2_HOST="${SOURCE2_HOST:-192.168.4.21}"
SOURCE2_PORT="${SOURCE2_PORT:-4403}"
SOURCE2_GAUNTLET="${SOURCE2_GAUNTLET:-2}"

SKIP_SOURCES="${SKIP_SOURCES:-false}"

COOKIE_FILE="/tmp/meshmonitor-setup-cookies.txt"
CSRF_FILE="/tmp/meshmonitor-setup-csrf.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────

cleanup() {
  rm -f "$COOKIE_FILE" "$CSRF_FILE"
}
trap cleanup EXIT

get_csrf_token() {
  local response
  response=$(curl -sf -c "$COOKIE_FILE" "${API_BASE_URL}/api/csrf-token")
  local token
  token=$(echo "$response" | jq -r '.csrfToken // empty')
  if [ -z "$token" ]; then
    echo -e "${RED}Failed to get CSRF token${NC}" >&2
    return 1
  fi
  echo "$token" > "$CSRF_FILE"
  echo "$token"
}

login() {
  echo -e "${BLUE}Logging in as ${API_USER}...${NC}"
  local csrf
  csrf=$(get_csrf_token)

  local response
  response=$(curl -sf -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
    -X POST "${API_BASE_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf" \
    -d "{\"username\":\"${API_USER}\",\"password\":\"${API_PASS}\"}")

  local username
  username=$(echo "$response" | jq -r '.user.username // empty')
  if [ -z "$username" ]; then
    echo -e "${RED}Login failed${NC}" >&2
    echo "$response" >&2
    return 1
  fi
  echo -e "${GREEN}Logged in as: ${username}${NC}"
}

api_post() {
  local endpoint="$1"
  local data="$2"
  local csrf
  csrf=$(cat "$CSRF_FILE")
  curl -sf -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
    -X POST "${API_BASE_URL}${endpoint}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf" \
    -d "$data"
}

api_get() {
  local endpoint="$1"
  curl -sf -b "$COOKIE_FILE" "${API_BASE_URL}${endpoint}"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  MeshMonitor Dev Config Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Wait for the server to be ready
echo -e "${YELLOW}Waiting for server to be ready...${NC}"
for i in $(seq 1 30); do
  if curl -sf "${API_BASE_URL}/api/csrf-token" > /dev/null 2>&1; then
    echo -e "${GREEN}Server is ready${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}Server not ready after 30 seconds. Is it running?${NC}"
    exit 1
  fi
  sleep 1
done

login

# ─── Sources ──────────────────────────────────────────────────────────────────

SOURCE1_ID=""
SOURCE2_ID=""

if [ "$SKIP_SOURCES" = "true" ]; then
  echo -e "${YELLOW}Skipping source creation (SKIP_SOURCES=true)${NC}"
  # Still need to fetch existing source IDs for per-source settings
  SOURCES=$(api_get "/api/sources")
  SOURCE1_ID=$(echo "$SOURCES" | jq -r --arg name "$SOURCE1_NAME" '.[] | select(.name == $name) | .id // empty')
  SOURCE2_ID=$(echo "$SOURCES" | jq -r --arg name "$SOURCE2_NAME" '.[] | select(.name == $name) | .id // empty')
else
  # Check for existing sources
  SOURCES=$(api_get "/api/sources" 2>/dev/null || echo "[]")
  SOURCE_COUNT=$(echo "$SOURCES" | jq 'length')

  echo -e "${BLUE}Found ${SOURCE_COUNT} existing source(s)${NC}"

  # Look for sources by name
  SOURCE1_ID=$(echo "$SOURCES" | jq -r --arg name "$SOURCE1_NAME" '.[] | select(.name == $name) | .id // empty')
  SOURCE2_ID=$(echo "$SOURCES" | jq -r --arg name "$SOURCE2_NAME" '.[] | select(.name == $name) | .id // empty')

  # Create Source 1 if it doesn't exist
  if [ -z "$SOURCE1_ID" ]; then
    echo -e "${YELLOW}Creating source: ${SOURCE1_NAME} (${SOURCE1_HOST}:${SOURCE1_PORT})${NC}"
    RESULT=$(api_post "/api/sources" "{
      \"name\": \"${SOURCE1_NAME}\",
      \"type\": \"meshtastic_tcp\",
      \"config\": {
        \"host\": \"${SOURCE1_HOST}\",
        \"port\": ${SOURCE1_PORT}
      },
      \"enabled\": true
    }")
    SOURCE1_ID=$(echo "$RESULT" | jq -r '.id // empty')
    if [ -z "$SOURCE1_ID" ]; then
      echo -e "${RED}Failed to create source 1${NC}"
      echo "$RESULT" >&2
      exit 1
    fi
    echo -e "${GREEN}Created ${SOURCE1_NAME}: ${SOURCE1_ID}${NC}"
  else
    echo -e "${GREEN}${SOURCE1_NAME} already exists: ${SOURCE1_ID}${NC}"
  fi

  # Create Source 2 if it doesn't exist
  if [ -z "$SOURCE2_ID" ]; then
    echo -e "${YELLOW}Creating source: ${SOURCE2_NAME} (${SOURCE2_HOST}:${SOURCE2_PORT})${NC}"
    RESULT=$(api_post "/api/sources" "{
      \"name\": \"${SOURCE2_NAME}\",
      \"type\": \"meshtastic_tcp\",
      \"config\": {
        \"host\": \"${SOURCE2_HOST}\",
        \"port\": ${SOURCE2_PORT}
      },
      \"enabled\": true
    }")
    SOURCE2_ID=$(echo "$RESULT" | jq -r '.id // empty')
    if [ -z "$SOURCE2_ID" ]; then
      echo -e "${RED}Failed to create source 2${NC}"
      echo "$RESULT" >&2
      exit 1
    fi
    echo -e "${GREEN}Created ${SOURCE2_NAME}: ${SOURCE2_ID}${NC}"
  else
    echo -e "${GREEN}${SOURCE2_NAME} already exists: ${SOURCE2_ID}${NC}"
  fi
fi

# ─── Global Settings ─────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}Configuring global settings...${NC}"

api_post "/api/settings" '{
  "packet_log_enabled": "1",
  "packet_log_max_count": "10000",
  "packet_log_max_age_hours": "48"
}' > /dev/null

echo -e "${GREEN}  Packet monitor: enabled (max 10000 packets, 48h retention)${NC}"

# ─── Per-Source Settings ──────────────────────────────────────────────────────

configure_auto_ack() {
  local source_id="$1"
  local source_name="$2"
  local gauntlet_channel="$3"

  if [ -z "$source_id" ]; then
    echo -e "${YELLOW}  Skipping auto-ack for ${source_name} (no source ID)${NC}"
    return
  fi

  echo -e "${BLUE}Configuring auto-ack for ${source_name} (channel ${gauntlet_channel})...${NC}"

  api_post "/api/settings?sourceId=${source_id}" "{
    \"autoAckEnabled\": \"true\",
    \"autoAckChannels\": \"${gauntlet_channel}\",
    \"autoAckRegex\": \"^(test|ping|hello)\",
    \"autoAckReplyEnabled\": \"true\",
    \"autoAckDirectEnabled\": \"true\",
    \"autoAckMessage\": \"Acknowledged! MeshMonitor received your message.\",
    \"autoAckCooldownSeconds\": \"60\",
    \"packet_log_enabled\": \"1\"
  }" > /dev/null

  echo -e "${GREEN}  ${source_name}: auto-ack on channel ${gauntlet_channel}, packet monitor enabled${NC}"
}

echo ""
configure_auto_ack "$SOURCE1_ID" "$SOURCE1_NAME" "$SOURCE1_GAUNTLET"
configure_auto_ack "$SOURCE2_ID" "$SOURCE2_NAME" "$SOURCE2_GAUNTLET"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  Configuration Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "  ${SOURCE1_NAME}: ${SOURCE1_ID:-not configured}"
echo -e "    Host: ${SOURCE1_HOST}:${SOURCE1_PORT}"
echo -e "    Gauntlet channel: ${SOURCE1_GAUNTLET}"
echo -e "    Auto-ack: enabled"
echo ""
echo -e "  ${SOURCE2_NAME}: ${SOURCE2_ID:-not configured}"
echo -e "    Host: ${SOURCE2_HOST}:${SOURCE2_PORT}"
echo -e "    Gauntlet channel: ${SOURCE2_GAUNTLET}"
echo -e "    Auto-ack: enabled"
echo ""
echo -e "  Packet monitor: enabled (global + per-source)"
echo ""
