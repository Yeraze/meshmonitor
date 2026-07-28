#!/usr/bin/env bash
# ==============================================================================
# First-time setup script
# Creates directories, configures environment, builds and starts containers
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
info "Checking dependencies..."

if ! command -v docker &>/dev/null; then
    error "Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/"
fi

if docker compose version &>/dev/null; then
    COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
    COMPOSE="docker-compose"
else
    error "docker-compose is not installed. Install it: https://docs.docker.com/compose/install/"
fi

info "Using: $COMPOSE"

# ---------------------------------------------------------------------------
# Project directory setup
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
else
    PROJECT_DIR="$SCRIPT_DIR"
fi

cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# Create data directories if needed
# ---------------------------------------------------------------------------
if [ -f docker-compose.yml ]; then
    # Extract volume mount paths from docker-compose.yml and create local ones
    if grep -q "^\s*-\s*\./data:" docker-compose.yml 2>/dev/null; then
        info "Creating local data directory..."
        mkdir -p data
    fi
fi

# ---------------------------------------------------------------------------
# Environment file setup
# ---------------------------------------------------------------------------
if [ -f .env ]; then
    warn ".env already exists. Skipping environment setup."
    warn "Edit .env manually if you need to change values."
else
    if [ -f .env.example ]; then
        info "Creating .env from template..."
        cp .env.example .env
        
        echo ""
        echo "========================================"
        echo "  Configure your environment variables  "
        echo "========================================"
        echo ""
        echo "Please edit .env and fill in required values."
        echo "Then re-run this script to build and start."
        echo ""
        
        exit 0
    else
        warn "No .env.example found. Proceeding without environment configuration."
    fi
fi

# ---------------------------------------------------------------------------
# Build and start
# ---------------------------------------------------------------------------
echo ""
info "Building Docker image..."
$COMPOSE build

info "Starting containers..."
$COMPOSE up -d

echo ""
echo "========================================"
echo -e "  ${GREEN}Service is running!${NC}"
echo ""

# Try to detect the port from docker-compose.yml
PORT=$(grep -E "^\s*-\s*['\"]?[0-9]+:" docker-compose.yml 2>/dev/null | head -1 | sed -E "s/.*['\"]?([0-9]+):.*/\1/" || echo "")

if [ -n "$PORT" ]; then
    if command -v hostname &>/dev/null; then
        HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    else
        HOST_IP="localhost"
    fi
    echo "  Access: http://${HOST_IP}:${PORT}"
fi

echo "  Logs:   $COMPOSE logs -f"
echo "========================================"
