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
DOCKER_SOCKET_TEST_SCRIPT="${DOCKER_SOCKET_TEST_SCRIPT:-/data/.meshmonitor-internal/test-docker-socket.sh}"

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

  # Verify /data directory exists and is accessible
  if [ ! -d "/data" ]; then
    log_error "/data directory does not exist"
    return 1
  fi

  # Create backup directory with error checking
  if ! mkdir -p "$BACKUP_DIR" 2>/tmp/backup-error.log; then
    log_error "Failed to create backup directory: $BACKUP_DIR"
    if [ -f /tmp/backup-error.log ]; then
      log_error "Error: $(cat /tmp/backup-error.log)"
      rm -f /tmp/backup-error.log
    fi
    return 1
  fi

  # Verify backup directory was created
  if [ ! -d "$BACKUP_DIR" ]; then
    log_error "Backup directory does not exist after mkdir: $BACKUP_DIR"
    return 1
  fi

  # Log directory info for debugging
  log "Backup directory info: $(ls -ld "$BACKUP_DIR" 2>&1 || echo 'unable to stat')"

  # Create backup (exclude backups directory itself)
  # Capture stderr to a temp file for better error reporting
  # Note: tar may report warnings about files disappearing (e.g., SQLite journal files)
  # which can be safely ignored as long as the backup file is created successfully
  tar -czf "$backup_path.tar.gz" -C /data --exclude='backups' --exclude='.upgrade-*' . 2>/tmp/tar-error.log
  local tar_exit=$?

  # Check if backup file was created and has content
  if [ ! -f "$backup_path.tar.gz" ]; then
    log_error "Backup file was not created: $backup_path.tar.gz"

    # Show tar errors
    if [ -f /tmp/tar-error.log ]; then
      log_error "tar error output:"
      while IFS= read -r line; do
        log_error "  $line"
      done < /tmp/tar-error.log
    fi

    rm -f /tmp/tar-error.log
    return 1
  fi

  local backup_size=$(stat -c%s "$backup_path.tar.gz" 2>/dev/null || echo "0")

  # Check if backup is too small (likely corrupt)
  if [ "$backup_size" -lt 100 ]; then
    log_error "Backup file is suspiciously small (${backup_size} bytes)"
    rm -f /tmp/tar-error.log
    return 1
  fi

  # Exit code 0 = success, 1 = warnings (e.g., file changed during read)
  # Both are acceptable as long as the backup file exists and has reasonable size
  if [ $tar_exit -eq 0 ] || [ $tar_exit -eq 1 ]; then
    if [ $tar_exit -eq 1 ] && [ -f /tmp/tar-error.log ]; then
      # Log warnings but don't fail
      log_warn "tar reported warnings (likely ephemeral files like SQLite journals):"
      while IFS= read -r line; do
        log_warn "  $line"
      done < /tmp/tar-error.log
    fi

    log_success "Backup created: $backup_path.tar.gz (${backup_size} bytes)"
    rm -f /tmp/tar-error.log
    echo "$backup_path.tar.gz"
    return 0
  else
    log_error "Failed to create backup (tar exit code: $tar_exit)"

    # Show the actual tar error
    if [ -f /tmp/tar-error.log ]; then
      log_error "tar error output:"
      while IFS= read -r line; do
        log_error "  $line"
      done < /tmp/tar-error.log
    fi

    rm -f /tmp/tar-error.log
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

  # Resolve compose directory - try configured path, then known mount points
  # Older sidecar configs used /data/compose, current uses /compose
  local compose_dir=""
  if [ -d "$COMPOSE_PROJECT_DIR" ] && [ -f "$COMPOSE_PROJECT_DIR/docker-compose.yml" ]; then
    compose_dir="$COMPOSE_PROJECT_DIR"
  elif [ -d "/compose" ] && [ -f "/compose/docker-compose.yml" ]; then
    log_warn "COMPOSE_PROJECT_DIR=$COMPOSE_PROJECT_DIR not found, falling back to /compose"
    compose_dir="/compose"
  elif [ -d "/data/compose" ] && [ -f "/data/compose/docker-compose.yml" ]; then
    log_warn "Falling back to legacy path /data/compose - please update COMPOSE_PROJECT_DIR to /compose"
    compose_dir="/data/compose"
  fi

  if [ -z "$compose_dir" ]; then
    log_error "No docker-compose.yml found at $COMPOSE_PROJECT_DIR, /compose, or /data/compose"
    log_error "The upgrade sidecar requires Docker Compose files to recreate containers safely."
    log_error "Mount your compose directory to /compose in the sidecar container."
    return 1
  fi

  log "Using compose directory: $compose_dir"

  # Verify docker compose is available
  if ! docker compose version >/dev/null 2>&1; then
    log_error "docker compose not available - required for container recreation"
    return 1
  fi

  # Detect which compose files were originally used
  local original_config_files=$(docker inspect --format='{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$CONTAINER_NAME" 2>/dev/null || echo "")

  local compose_files=""
  if [ -n "$original_config_files" ]; then
    log "Original compose files: $original_config_files"
    for config_file in $(echo "$original_config_files" | tr ',' ' '); do
      local filename=$(basename "$config_file")
      if [ -f "$compose_dir/$filename" ]; then
        compose_files="$compose_files -f $filename"
        log "  Using: $filename"
      else
        log_warn "  Not found: $filename (skipping)"
      fi
    done
  fi

  # Fallback if no compose files detected from labels
  if [ -z "$compose_files" ]; then
    compose_files="-f docker-compose.yml"
    if [ -f "$compose_dir/docker-compose.upgrade.yml" ]; then
      compose_files="$compose_files -f docker-compose.upgrade.yml"
    fi
    log "Using default compose files: $compose_files"
  fi

  # Detect project name from container labels
  local detected_project=$(docker inspect --format='{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER_NAME" 2>/dev/null || echo "")
  local project_flag=""
  if [ -n "$detected_project" ]; then
    project_flag="-p $detected_project"
    log "Using project name: $detected_project"
  elif [ -n "$COMPOSE_PROJECT_NAME" ]; then
    project_flag="-p $COMPOSE_PROJECT_NAME"
    log "Using env project name: $COMPOSE_PROJECT_NAME"
  fi

  # Pull latest image
  log "Pulling latest image..."
  if docker pull "${IMAGE_NAME}:latest" 2>/dev/null; then
    log_success "Image pulled: ${IMAGE_NAME}:latest"
  fi

  # Recreate via docker compose (handles ports, volumes, env, networks - everything)
  cd "$compose_dir" || return 1
  log "Running: docker compose $project_flag $compose_files up -d --force-recreate --no-deps $CONTAINER_NAME"

  if docker compose $project_flag $compose_files up -d --force-recreate --no-deps "$CONTAINER_NAME"; then
    # Log the port mappings on the new container for verification
    local new_ports=$(docker port "$CONTAINER_NAME" 2>/dev/null)
    if [ -n "$new_ports" ]; then
      log "Port mappings on recreated container:"
      echo "$new_ports" | while IFS= read -r line; do log "  $line"; done
    fi
    log_success "Container recreated successfully via Docker Compose"
    return 0
  else
    log_error "Failed to recreate container via Docker Compose"
    return 1
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

  while [ $elapsed -lt $max_wait ]; do
    # Check if container is running
    if ! docker ps --filter "name=$CONTAINER_NAME" --filter "status=running" | grep -q "$CONTAINER_NAME"; then
      log_warn "Container not running yet..."
      sleep 5
      elapsed=$((elapsed + 5))
      continue
    fi

    # Get container IP directly from Docker inspect - more reliable than DNS after recreation
    # Try multiple networks as the container might be on different networks
    local container_ip=""
    container_ip=$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | head -n1)

    # If no IP yet, wait for container to get network assigned
    if [ -z "$container_ip" ]; then
      log_warn "Container has no IP assigned yet..."
      sleep 5
      elapsed=$((elapsed + 5))
      continue
    fi

    local health_url="http://${container_ip}:3001${health_path}"

    # Only log URL on first attempt or if it changed
    if [ "$elapsed" -eq 0 ] || [ -z "$last_health_url" ] || [ "$health_url" != "$last_health_url" ]; then
      log "Health endpoint: $health_url"
      last_health_url="$health_url"
    fi

    # Try to check health endpoint using container IP directly
    # This is more reliable than container name DNS after recreation
    if wget -q -O /dev/null --timeout=5 "$health_url" 2>/dev/null || \
       curl -sf "$health_url" >/dev/null 2>&1; then
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

# Clean up old Docker images to free disk space
cleanup_old_images() {
  log "Cleaning up old MeshMonitor images..."

  # Get the current image ID being used by the container
  local current_image_id=$(docker inspect --format='{{.Image}}' "$CONTAINER_NAME" 2>/dev/null | cut -d':' -f2 | cut -c1-12)

  if [ -z "$current_image_id" ]; then
    log_warn "Could not determine current image ID, skipping cleanup"
    return 0
  fi

  log "Current image ID: $current_image_id"

  # Find all MeshMonitor images (excluding the current one)
  local old_images=$(docker images "${IMAGE_NAME}" --format '{{.ID}} {{.Tag}}' 2>/dev/null | while read id tag; do
    # Get short ID for comparison
    local short_id=$(echo "$id" | cut -c1-12)
    if [ "$short_id" != "$current_image_id" ]; then
      echo "$id"
    fi
  done)

  if [ -z "$old_images" ]; then
    log "No old images to clean up"
    return 0
  fi

  # Count images to be removed
  local image_count=$(echo "$old_images" | wc -l)
  log "Found $image_count old image(s) to remove"

  # Remove each old image
  local removed=0
  local failed=0
  for image_id in $old_images; do
    if docker rmi "$image_id" 2>/dev/null; then
      removed=$((removed + 1))
      log "Removed image: $image_id"
    else
      failed=$((failed + 1))
      log_warn "Could not remove image: $image_id (may be in use)"
    fi
  done

  if [ $removed -gt 0 ]; then
    log_success "Cleaned up $removed old image(s)"
  fi

  if [ $failed -gt 0 ]; then
    log_warn "$failed image(s) could not be removed"
  fi

  # Also clean up dangling images (untagged images from the build process)
  local dangling=$(docker images -f "dangling=true" -q 2>/dev/null)
  if [ -n "$dangling" ]; then
    log "Removing dangling images..."
    echo "$dangling" | xargs docker rmi 2>/dev/null || true
    log_success "Dangling images cleaned up"
  fi

  return 0
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

  # Step 5: Clean up old images to free disk space
  write_status "cleanup"
  cleanup_old_images

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

  # Warn if running from the legacy script path
  SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  case "$SCRIPT_PATH" in
    /data/scripts/*)
      log_warn "=================================================="
      log_warn "Running from legacy path: $SCRIPT_PATH"
      log_warn "Please update your docker-compose.upgrade.yml to use:"
      log_warn "  command: /data/.meshmonitor-internal/upgrade-watchdog.sh"
      log_warn "See: https://github.com/Yeraze/meshmonitor/blob/main/docker-compose.upgrade.yml"
      log_warn "=================================================="
      ;;
  esac

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
