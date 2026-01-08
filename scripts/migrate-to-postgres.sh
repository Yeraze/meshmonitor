#!/bin/bash
#
# MeshMonitor SQLite to PostgreSQL Migration Script
#
# This script migrates an existing SQLite-based MeshMonitor installation
# to PostgreSQL. It will:
#   1. Stop the running MeshMonitor container
#   2. Extract the SQLite database
#   3. Add PostgreSQL to your docker-compose.yml
#   4. Start PostgreSQL and run the migration
#   5. Update MeshMonitor to use PostgreSQL
#   6. Restart everything
#
# Usage: ./migrate-to-postgres.sh [docker-compose.yml path]
#
# Requirements:
#   - Docker and docker compose
#   - An existing MeshMonitor installation using SQLite
#   - The MeshMonitor container must be named 'meshmonitor' (or update CONTAINER_NAME below)
#

set -e

# Configuration - adjust these if needed
CONTAINER_NAME="${MESHMONITOR_CONTAINER:-meshmonitor}"
POSTGRES_USER="${POSTGRES_USER:-meshmonitor}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)}"
POSTGRES_DB="${POSTGRES_DB:-meshmonitor}"
COMPOSE_FILE="${1:-docker-compose.yml}"
BACKUP_DIR="./migration-backup-$(date +%Y%m%d-%H%M%S)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo "=============================================="
echo "  MeshMonitor SQLite to PostgreSQL Migration"
echo "=============================================="
echo ""

# Check prerequisites
log_info "Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed or not in PATH"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    log_error "docker compose is not available"
    exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
    log_error "docker-compose file not found: $COMPOSE_FILE"
    log_info "Usage: $0 [path/to/docker-compose.yml]"
    exit 1
fi

# Check if container exists
if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    log_error "Container '$CONTAINER_NAME' not found"
    log_info "Set MESHMONITOR_CONTAINER env var if using a different name"
    exit 1
fi

log_success "Prerequisites check passed"

# Create backup directory
log_info "Creating backup directory: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

# Backup current docker-compose.yml
cp "$COMPOSE_FILE" "$BACKUP_DIR/docker-compose.yml.backup"
log_success "Backed up docker-compose.yml"

# Step 1: Stop MeshMonitor
log_info "Stopping MeshMonitor container..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
log_success "MeshMonitor stopped"

# Step 2: Extract SQLite database
log_info "Extracting SQLite database..."
docker cp "$CONTAINER_NAME:/data/meshmonitor.db" "$BACKUP_DIR/meshmonitor.db"
if [ ! -f "$BACKUP_DIR/meshmonitor.db" ]; then
    log_error "Failed to extract SQLite database"
    exit 1
fi
SQLITE_SIZE=$(du -h "$BACKUP_DIR/meshmonitor.db" | cut -f1)
log_success "Extracted SQLite database ($SQLITE_SIZE)"

# Step 3: Check if PostgreSQL is already in docker-compose
if grep -q "postgres:" "$COMPOSE_FILE" || grep -q "postgresql:" "$COMPOSE_FILE"; then
    log_warn "PostgreSQL service already exists in $COMPOSE_FILE"
    log_info "Skipping docker-compose modification"
else
    log_info "Adding PostgreSQL service to docker-compose.yml..."

    # Create the postgres service snippet
    POSTGRES_SERVICE="
  postgres:
    image: postgres:16-alpine
    container_name: meshmonitor-postgres
    restart: unless-stopped
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=${POSTGRES_DB}
      - POSTGRES_USER=${POSTGRES_USER}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    healthcheck:
      test: [\"CMD-SHELL\", \"pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}\"]
      interval: 10s
      timeout: 5s
      retries: 5
"

    # Check if there's a volumes section
    if grep -q "^volumes:" "$COMPOSE_FILE"; then
        # Add postgres-data to existing volumes section
        if ! grep -q "postgres-data:" "$COMPOSE_FILE"; then
            sed -i '/^volumes:/a\  postgres-data:\n    driver: local' "$COMPOSE_FILE"
        fi
    else
        # Add volumes section at the end
        echo -e "\nvolumes:\n  postgres-data:\n    driver: local" >> "$COMPOSE_FILE"
    fi

    # Add postgres service after 'services:' line
    # Using awk for more reliable multi-line insertion
    awk -v service="$POSTGRES_SERVICE" '
        /^services:/ { print; getline; print service; }
        { print }
    ' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp" && mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"

    log_success "Added PostgreSQL service to docker-compose.yml"
fi

# Step 4: Start PostgreSQL
log_info "Starting PostgreSQL..."
docker compose -f "$COMPOSE_FILE" up -d postgres

# Wait for PostgreSQL to be ready
log_info "Waiting for PostgreSQL to be ready..."
RETRIES=30
until docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [ $RETRIES -le 0 ]; then
        log_error "PostgreSQL failed to start"
        exit 1
    fi
    echo -n "."
    sleep 2
done
echo ""
log_success "PostgreSQL is ready"

# Step 5: Run migration
log_info "Running database migration..."
POSTGRES_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}"

# Run migration using the MeshMonitor container
docker run --rm \
    -v "$PWD/$BACKUP_DIR/meshmonitor.db:/data/meshmonitor.db:ro" \
    --network host \
    ghcr.io/yeraze/meshmonitor:latest \
    npm run migrate-db -- \
    --from "sqlite:/data/meshmonitor.db" \
    --to "$POSTGRES_URL"

if [ $? -ne 0 ]; then
    log_error "Migration failed!"
    log_info "Your original database is preserved at: $BACKUP_DIR/meshmonitor.db"
    exit 1
fi

log_success "Migration completed successfully"

# Step 6: Update MeshMonitor service in docker-compose
log_info "Updating MeshMonitor configuration..."

# Check if DATABASE_URL is already set
if grep -q "DATABASE_URL" "$COMPOSE_FILE"; then
    log_warn "DATABASE_URL already exists in $COMPOSE_FILE"
    log_info "Please manually update it to: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
else
    # Add DATABASE_URL to meshmonitor service environment
    # This is tricky with sed, so we'll use a more robust approach

    # Create .env file with credentials if it doesn't exist
    ENV_FILE=".env"
    if [ ! -f "$ENV_FILE" ]; then
        touch "$ENV_FILE"
    fi

    # Add/update postgres credentials in .env
    if grep -q "POSTGRES_PASSWORD" "$ENV_FILE"; then
        sed -i "s/POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${POSTGRES_PASSWORD}/" "$ENV_FILE"
    else
        echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" >> "$ENV_FILE"
    fi

    if grep -q "POSTGRES_USER" "$ENV_FILE"; then
        sed -i "s/POSTGRES_USER=.*/POSTGRES_USER=${POSTGRES_USER}/" "$ENV_FILE"
    else
        echo "POSTGRES_USER=${POSTGRES_USER}" >> "$ENV_FILE"
    fi

    log_success "PostgreSQL credentials saved to .env file"

    echo ""
    log_warn "Please add the following to your meshmonitor service in $COMPOSE_FILE:"
    echo ""
    echo "    environment:"
    echo "      - DATABASE_URL=postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
    echo "    depends_on:"
    echo "      postgres:"
    echo "        condition: service_healthy"
    echo ""
fi

# Step 7: Provide final instructions
echo ""
echo "=============================================="
echo "  Migration Complete!"
echo "=============================================="
echo ""
log_success "SQLite database migrated to PostgreSQL"
echo ""
echo "PostgreSQL Credentials (saved to .env):"
echo "  User:     ${POSTGRES_USER}"
echo "  Password: ${POSTGRES_PASSWORD}"
echo "  Database: ${POSTGRES_DB}"
echo ""
echo "Next steps:"
echo "  1. Update your docker-compose.yml meshmonitor service:"
echo ""
echo "     environment:"
echo "       - DATABASE_URL=postgres://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
echo "     depends_on:"
echo "       postgres:"
echo "         condition: service_healthy"
echo ""
echo "  2. Start MeshMonitor:"
echo "     docker compose up -d"
echo ""
echo "  3. Verify it's using PostgreSQL:"
echo "     docker compose logs meshmonitor | grep -i postgres"
echo ""
echo "Backup location: $BACKUP_DIR"
echo "  - Original docker-compose.yml: $BACKUP_DIR/docker-compose.yml.backup"
echo "  - SQLite database: $BACKUP_DIR/meshmonitor.db"
echo ""
