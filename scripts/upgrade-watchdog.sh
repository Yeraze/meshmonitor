#!/bin/sh
# MeshMonitor Upgrade Watchdog
# Monitors for upgrade trigger file and performs Docker container upgrade

set -e

# Configuration
TRIGGER_FILE="${TRIGGER_FILE:-/data/.upgrade-trigger}"
STATUS_FILE="${STATUS_FILE:-/data/.upgrade-status}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
CONTAINER_NAME="${CONTAINER_NAME:-meshmonitor}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/yeraze/meshmonitor}"
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-/compose}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
  echo "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

log_success() {
  echo "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ✅ $1"
}

log_warn() {
  echo "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ⚠️  $1"
}

log_error() {
  echo "${RED}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ❌ $1"
}

# Write status to file for backend to read
write_status() {
  echo "$1" > "$STATUS_FILE"
  log "Status: $1"
}

# Create backup of data directory
create_backup() {
  local backup_name="upgrade-backup-$(date +%Y%m%d_%H%M%S)"
  local backup_path="$BACKUP_DIR/$backup_name"

  log "Creating backup: $backup_path"

  mkdir -p "$BACKUP_DIR"

  # Create backup (exclude backups directory itself)
  if tar -czf "$backup_path.tar.gz" -C /data --exclude='backups' --exclude='.upgrade-*' . 2>/dev/null; then
    log_success "Backup created: $backup_path.tar.gz"
    echo "$backup_path.tar.gz"
    return 0
  else
    log_error "Failed to create backup"
    return 1
  fi
}

# Pull new Docker image
pull_image() {
  local version="$1"
  local image="${IMAGE_NAME}:${version}"

  log "Pulling image: $image"

  if docker pull "$image"; then
    log_success "Image pulled: $image"

    # Tag as latest if not already latest
    if [ "$version" != "latest" ]; then
      docker tag "$image" "${IMAGE_NAME}:latest"
      log_success "Tagged as latest"
    fi

    return 0
  else
    log_error "Failed to pull image: $image"
    return 1
  fi
}

# Recreate container with new image
recreate_container() {
  log "Recreating container: $CONTAINER_NAME"

  # Use direct Docker commands to recreate the container
  # This works regardless of which compose files were originally used
  log "Recreating container using Docker commands"

  # Pull the new image
  if docker pull "${IMAGE_NAME}:latest" 2>/dev/null; then
    log_success "Image pulled: ${IMAGE_NAME}:latest"
  fi

  # Get current container configuration before stopping
  local network=$(docker inspect --format='{{range $net,$v := .NetworkSettings.Networks}}{{$net}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | head -n1)
  local volumes=$(docker inspect --format='{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}}{{if .RW}}{{else}}:ro{{end}} {{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null)
  local ports=$(docker inspect --format='{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}-p {{(index $conf 0).HostPort}}:{{$p}} {{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null)
  local env_vars=$(docker inspect --format='{{range .Config.Env}}-e {{.}} {{end}}' "$CONTAINER_NAME" 2>/dev/null)

  # Stop and remove old container
  log "Stopping current container..."
  docker stop "$CONTAINER_NAME" || true
  docker rm "$CONTAINER_NAME" || true

  # Start new container with same configuration
  log "Starting new container..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    $ports \
    $volumes \
    $env_vars \
    ${network:+--network "$network"} \
    "${IMAGE_NAME}:latest"

  if [ $? -eq 0 ]; then
    log_success "Container recreated successfully"
    return 0
  else
    log_error "Failed to recreate container"
    return 1
  fi
}

# Wait for container health check
wait_for_health() {
  local max_wait=120
  local elapsed=0

  log "Waiting for container health check..."

  while [ $elapsed -lt $max_wait ]; do
    # Check if container is running
    if ! docker ps --filter "name=$CONTAINER_NAME" --filter "status=running" | grep -q "$CONTAINER_NAME"; then
      log_warn "Container not running yet..."
      sleep 5
      elapsed=$((elapsed + 5))
      continue
    fi

    # Try to check health endpoint
    if wget -q -O /dev/null --timeout=5 http://localhost:3001/api/health 2>/dev/null || \
       wget -q -O /dev/null --timeout=5 http://localhost:8080/api/health 2>/dev/null || \
       curl -sf http://localhost:3001/api/health >/dev/null 2>&1 || \
       curl -sf http://localhost:8080/api/health >/dev/null 2>&1; then
      log_success "Health check passed"
      return 0
    fi

    log "Waiting for health check... (${elapsed}s/${max_wait}s)"
    sleep 5
    elapsed=$((elapsed + 5))
  done

  log_error "Health check timeout after ${max_wait}s"
  return 1
}

# Perform upgrade
perform_upgrade() {
  local trigger_data
  local version
  local backup_enabled
  local upgrade_id
  local backup_path

  # Read trigger file
  if [ ! -f "$TRIGGER_FILE" ]; then
    log_error "Trigger file not found"
    return 1
  fi

  trigger_data=$(cat "$TRIGGER_FILE")
  version=$(echo "$trigger_data" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  backup_enabled=$(echo "$trigger_data" | grep -o '"backup":[^,}]*' | cut -d':' -f2)
  upgrade_id=$(echo "$trigger_data" | grep -o '"upgradeId":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$version" ]; then
    version="latest"
  fi

  log "=================================================="
  log "Starting upgrade to version: $version"
  log "Upgrade ID: $upgrade_id"
  log "Backup enabled: $backup_enabled"
  log "=================================================="

  # Remove trigger file immediately to prevent re-triggering
  rm -f "$TRIGGER_FILE"

  # Step 1: Create backup
  if [ "$backup_enabled" != "false" ]; then
    write_status "backing_up"
    if backup_path=$(create_backup); then
      log_success "Backup completed: $backup_path"
    else
      write_status "failed"
      log_error "Backup failed - aborting upgrade"
      return 1
    fi
  else
    log_warn "Backup disabled - skipping"
  fi

  # Step 2: Pull new image
  write_status "downloading"
  if ! pull_image "$version"; then
    write_status "failed"
    log_error "Image pull failed - aborting upgrade"
    return 1
  fi

  # Step 3: Recreate container
  write_status "restarting"
  if ! recreate_container; then
    write_status "failed"
    log_error "Container recreation failed"

    # Attempt rollback if backup exists
    if [ -n "$backup_path" ] && [ -f "$backup_path" ]; then
      log_warn "Attempting rollback..."
      write_status "rolling_back"
      # Rollback logic would go here
      # For now, just log the error
      log_error "Manual intervention required - backup available at: $backup_path"
    fi

    return 1
  fi

  # Step 4: Health check
  write_status "health_check"
  if ! wait_for_health; then
    write_status "failed"
    log_error "Health check failed - upgrade may have issues"
    return 1
  fi

  # Success!
  write_status "complete"
  log_success "=================================================="
  log_success "Upgrade completed successfully!"
  log_success "Version: $version"
  log_success "Upgrade ID: $upgrade_id"
  log_success "=================================================="

  return 0
}

# Main loop
main() {
  log "=================================================="
  log "MeshMonitor Upgrade Watchdog Starting"
  log "=================================================="
  log "Container: $CONTAINER_NAME"
  log "Image: $IMAGE_NAME"
  log "Trigger file: $TRIGGER_FILE"
  log "Check interval: ${CHECK_INTERVAL}s"
  log "Compose project: $COMPOSE_PROJECT_DIR"
  log "=================================================="

  # Initialize status
  write_status "ready"

  while true; do
    if [ -f "$TRIGGER_FILE" ]; then
      log "Upgrade trigger detected!"

      if perform_upgrade; then
        log_success "Upgrade process completed"
      else
        log_error "Upgrade process failed"
      fi

      # Clean up
      rm -f "$TRIGGER_FILE"
    fi

    sleep "$CHECK_INTERVAL"
  done
}

# Handle signals
trap 'log "Shutting down watchdog..."; exit 0' SIGTERM SIGINT

# Run main loop
main
