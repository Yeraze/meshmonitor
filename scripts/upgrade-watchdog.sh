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
DOCKER_SOCKET_TEST_REQUEST="${DOCKER_SOCKET_TEST_REQUEST:-/data/.docker-socket-test-request}"
DOCKER_SOCKET_TEST_SCRIPT="${DOCKER_SOCKET_TEST_SCRIPT:-/data/scripts/test-docker-socket.sh}"

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

  # Use Docker Compose if available, otherwise fall back to Docker commands
  # Docker Compose ensures proper container management and avoids conflicts

  if [ -d "$COMPOSE_PROJECT_DIR" ] && [ -f "$COMPOSE_PROJECT_DIR/docker-compose.yml" ]; then
    log "Using Docker Compose to recreate container"

    # Detect which compose files were originally used by inspecting the container
    local original_config_files=$(docker inspect --format='{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER_NAME" 2>/dev/null || echo "")

    local compose_files=""
    if [ -n "$original_config_files" ]; then
      log "Original compose files: $original_config_files"
      # Parse comma-separated list and convert /compose/ paths to -f flags
      # Example: /compose/docker-compose.yml,/compose/docker-compose.dev.yml
      for config_file in $(echo "$original_config_files" | tr ',' ' '); do
        # Extract just the filename (remove /compose/ prefix)
        local filename=$(basename "$config_file")
        if [ -f "$COMPOSE_PROJECT_DIR/$filename" ]; then
          compose_files="$compose_files -f $filename"
          log "Using compose file: $filename"
        else
          log_warn "Compose file not found: $filename (skipping)"
        fi
      done
    fi

    # Fallback if no compose files detected from labels
    if [ -z "$compose_files" ]; then
      log_warn "Could not detect original compose files, using defaults"
      compose_files="-f docker-compose.yml"
      if [ -f "$COMPOSE_PROJECT_DIR/docker-compose.upgrade.yml" ]; then
        compose_files="$compose_files -f docker-compose.upgrade.yml"
        log "Detected upgrade overlay: docker-compose.upgrade.yml"
      fi
    fi

    # Pull latest image
    if docker pull "${IMAGE_NAME}:latest" 2>/dev/null; then
      log_success "Image pulled: ${IMAGE_NAME}:latest"
    fi

    # Stop and remove existing container first to avoid name conflicts
    log "Stopping existing container..."
    cd "$COMPOSE_PROJECT_DIR" || return 1

    # Use project name if provided to ensure we target the correct compose project
    local project_flag=""
    if [ -n "$COMPOSE_PROJECT_NAME" ]; then
      project_flag="-p $COMPOSE_PROJECT_NAME"
      log "Using project name: $COMPOSE_PROJECT_NAME"
    fi

    docker compose $project_flag $compose_files stop meshmonitor 2>/dev/null || true
    docker compose $project_flag $compose_files rm -f meshmonitor 2>/dev/null || true

    # Recreate using docker compose (this properly handles all configuration)
    if docker compose $project_flag $compose_files up -d --no-deps meshmonitor; then
      log_success "Container recreated successfully via Docker Compose"
      return 0
    else
      log_error "Failed to recreate container via Docker Compose"
      return 1
    fi
  else
    # Fallback to direct Docker commands (legacy compatibility)
    log "Docker Compose files not found, using direct Docker commands"

    # Pull the new image
    if docker pull "${IMAGE_NAME}:latest" 2>/dev/null; then
      log_success "Image pulled: ${IMAGE_NAME}:latest"
    fi

    # Get current container configuration before stopping
    local network=$(docker inspect --format='{{range $net,$v := .NetworkSettings.Networks}}{{$net}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | head -n1)
    # Extract both volume and bind mounts
    local volumes=$(docker inspect --format='{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}}{{if .RW}}{{else}}:ro{{end}} {{else if eq .Type "bind"}}-v {{.Source}}:{{.Destination}}{{if .RW}}{{else}}:ro{{end}} {{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null)

    # Extract ports - remove /tcp or /udp protocol suffix for docker run compatibility
    local ports=$(docker inspect --format='{{range $p, $conf := .NetworkSettings.Ports}}{{if $conf}}-p {{(index $conf 0).HostPort}}:{{$p}} {{end}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | sed 's|/tcp||g; s|/udp||g')

    # Extract env vars to a temporary file to handle values with spaces properly
    local env_file="/tmp/.meshmonitor-upgrade-env-$$"
    docker inspect --format='{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | \
      grep -v '^COMPOSE_' | \
      grep -v '^DOCKER_' | \
      grep -v '^PATH=' | \
      grep -v '^HOME=' | \
      grep -v '^HOSTNAME=' | \
      grep -v '^$' > "$env_file"

    # Stop and remove old container
    log "Stopping current container..."
    docker stop "$CONTAINER_NAME" || true
    docker rm "$CONTAINER_NAME" || true

    # Start new container with same configuration
    log "Starting new container..."

    # Build command incrementally to handle optional network parameter
    set -- -d --name "$CONTAINER_NAME" --restart unless-stopped

    # Add network if present (using positional parameters to avoid word-splitting issues)
    if [ -n "$network" ]; then
      set -- "$@" --network "$network"
    fi

    # Execute docker run with all parameters
    # Note: $ports, $volumes are intentionally unquoted for word splitting
    # Use --env-file to properly handle env vars with spaces in values
    docker run "$@" $ports $volumes --env-file "$env_file" ghcr.io/yeraze/meshmonitor:latest
    local exit_code=$?

    # Clean up temp env file
    rm -f "$env_file"

    if [ $exit_code -eq 0 ]; then
      log_success "Container recreated successfully"
      return 0
    else
      log_error "Failed to recreate container"
      return 1
    fi
  fi
}

# Wait for container health check
wait_for_health() {
  local max_wait=120
  local elapsed=0

  log "Waiting for container health check..."

  # Get BASE_URL from container env vars, default to empty if not set
  local base_url=$(docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep '^BASE_URL=' | cut -d'=' -f2 | tr -d '\r\n')

  # Construct health endpoint URL with BASE_URL if present
  local health_path="/api/health"
  if [ -n "$base_url" ] && [ "$base_url" != "/" ]; then
    health_path="${base_url}/api/health"
  fi

  log "Health endpoint: http://$CONTAINER_NAME:3001${health_path}"

  while [ $elapsed -lt $max_wait ]; do
    # Check if container is running
    if ! docker ps --filter "name=$CONTAINER_NAME" --filter "status=running" | grep -q "$CONTAINER_NAME"; then
      log_warn "Container not running yet..."
      sleep 5
      elapsed=$((elapsed + 5))
      continue
    fi

    # Try to check health endpoint using container name
    # The upgrader runs in a separate container, so localhost won't work
    # Use the container name instead to reach the main meshmonitor container
    if wget -q -O /dev/null --timeout=5 "http://$CONTAINER_NAME:3001${health_path}" 2>/dev/null || \
       curl -sf "http://$CONTAINER_NAME:3001${health_path}" >/dev/null 2>&1; then
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
    # Check for Docker socket test request
    if [ -f "$DOCKER_SOCKET_TEST_REQUEST" ]; then
      log "Docker socket test request detected"

      if [ -f "$DOCKER_SOCKET_TEST_SCRIPT" ]; then
        # Make script executable and run it
        chmod +x "$DOCKER_SOCKET_TEST_SCRIPT"
        if sh "$DOCKER_SOCKET_TEST_SCRIPT"; then
          log_success "Docker socket test completed"
        else
          log_warn "Docker socket test completed with warnings/errors"
        fi
      else
        log_error "Docker socket test script not found: $DOCKER_SOCKET_TEST_SCRIPT"
        echo "FAIL: Test script not found at $DOCKER_SOCKET_TEST_SCRIPT" > /data/.docker-socket-test
      fi

      # Clean up test request
      rm -f "$DOCKER_SOCKET_TEST_REQUEST"
    fi

    # Check for upgrade trigger
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
