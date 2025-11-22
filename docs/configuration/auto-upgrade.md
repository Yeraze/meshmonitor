# Automatic Self-Upgrade

MeshMonitor supports automatic self-upgrade for Docker deployments, allowing you to upgrade to new versions directly from the web interface with a single click.

## Overview

When enabled, MeshMonitor displays an "Upgrade Now" button in the update notification banner whenever a new version is available. Clicking this button automatically:

1. Creates a backup of your data
2. Pulls the new Docker image
3. Recreates the container with the new version
4. Performs health checks
5. Automatically rolls back if the upgrade fails

:::info
**Deployment Support:**
- ✅ **Docker Compose** - Fully supported with watchdog sidecar
- ⚠️ **Kubernetes** - Use standard `kubectl` or Helm upgrades instead
- ❌ **Manual** - Not supported for manual Node.js deployments
:::

## How It Works

The auto-upgrade feature uses a **watchdog sidecar** container that:

- Monitors for upgrade triggers from the main application
- Has access to the Docker socket to manage containers
- Pulls new images and recreates containers
- Maintains all your existing configuration and data
- Automatically deploys the upgrade watchdog script to the shared data volume (no manual download needed)

```
┌─────────────────┐         ┌──────────────────┐
│   MeshMonitor   │ Trigger │  Watchdog Sidecar│
│   Container     ├────────→│  (docker:cli)    │
│                 │  File   │                  │
└────────┬────────┘         └────────┬─────────┘
         │                           │
         │  Shared /data volume      │
         └───────────────────────────┘
                     │
              Monitors for:
          /data/.upgrade-trigger
```

## Setup Instructions

### Docker Compose Setup

::: info
The upgrade watchdog script is automatically deployed to `/data/scripts/` by the MeshMonitor container on startup. No manual script download is required.
:::

1. **Enable the watchdog sidecar** by using the upgrade overlay:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d
   ```

2. **Verify the watchdog is running:**

   ```bash
   docker ps | grep upgrader
   ```

   You should see a container named `meshmonitor-upgrader` running.

3. **Access MeshMonitor** as normal. When an update is available, you'll see an "Upgrade Now" button in the notification banner.

### Configuration Options

The upgrade behavior can be customized via environment variables:

```yaml
# docker-compose.upgrade.yml (already configured)
services:
  meshmonitor:
    environment:
      - AUTO_UPGRADE_ENABLED=true  # Enable upgrade feature

  meshmonitor-upgrader:
    environment:
      - CHECK_INTERVAL=5            # Check for triggers every 5 seconds
      - CONTAINER_NAME=meshmonitor  # Name of container to upgrade
      - IMAGE_NAME=ghcr.io/yeraze/meshmonitor  # Image to pull
      - COMPOSE_PROJECT_NAME=meshmonitor  # Docker Compose project name (optional)
      - COMPOSE_PROJECT_DIR=/compose  # Path to docker-compose files
```

## Using the Upgrade Feature

### Step 1: Check for Updates

MeshMonitor automatically checks for new releases every 4 hours. When an update is available, a banner appears:

```
🔔 Update Available: Version 2.14.0 is now available. [View Release Notes →] [Upgrade Now]
```

### Step 2: Review Release Notes

Click "View Release Notes →" to see what's new in the latest version on GitHub.

### Step 3: Trigger Upgrade

Click the **"Upgrade Now"** button to start the automatic upgrade process.

### Step 4: Monitor Progress

The banner updates to show upgrade progress:

```
⚙️ Upgrading to 2.14.0... Creating backup... (20%)
⚙️ Upgrading to 2.14.0... Downloading new version... (40%)
⚙️ Upgrading to 2.14.0... Restarting services... (60%)
⚙️ Upgrading to 2.14.0... Running health checks... (80%)
✅ Upgrade complete! Reloading...
```

### Step 5: Automatic Reload

Once the upgrade completes, the page automatically reloads with the new version.

:::warning
**During Upgrade:**
- Do not close the browser tab
- The application will be unavailable for 10-30 seconds
- All WebSocket connections will be temporarily disconnected
:::

## Upgrade Process Details

### 1. Pre-flight Checks

Before starting, the system verifies:

- ✅ Sufficient disk space (500MB minimum)
- ✅ Backup directory is writable
- ✅ New Docker image exists in registry
- ✅ No other upgrade in progress

### 2. Backup Creation

A complete backup of `/data` is created:

```
/data/backups/upgrade-backup-20250107_143022.tar.gz
```

This includes:
- SQLite database
- Configuration files
- Apprise notification configs

### 3. Image Download

The watchdog pulls the new image:

```bash
docker pull ghcr.io/yeraze/meshmonitor:2.14.0
docker tag ghcr.io/yeraze/meshmonitor:2.14.0 ghcr.io/yeraze/meshmonitor:latest
```

### 4. Container Recreation

The watchdog detects which Docker Compose files were used to originally start the container and uses those same files to recreate it, preserving all configuration:

```bash
# Detect original compose files from container labels
docker inspect meshmonitor --format='{{index .Config.Labels "com.docker.compose.project.config_files"}}'
# Example: /compose/docker-compose.yml,/compose/docker-compose.dev.yml

# Recreate using the same compose files
docker compose -p meshmonitor -f docker-compose.yml -f docker-compose.dev.yml up -d --no-deps meshmonitor
```

This preserves:
- All environment variables (including those from overlay files)
- Volume mounts
- Network configuration
- Port mappings
- All Docker Compose overlay configurations

### 5. Health Checks

The watchdog waits up to 2 minutes for the health endpoint to respond:

```bash
GET http://localhost:3001/api/health
```

### 6. Automatic Rollback (if needed)

If health checks fail, the watchdog:

1. Stops the new container
2. Restores the previous image
3. Restores data from backup
4. Starts the previous version

## Upgrade History

View past upgrades in the database:

```sql
SELECT * FROM upgrade_history ORDER BY startedAt DESC LIMIT 10;
```

Each entry includes:
- Upgrade ID
- From/To versions
- Status (complete, failed, rolled_back)
- Timestamps
- Error messages (if failed)
- Backup path

## Troubleshooting

### Upgrade Button Not Appearing

**Problem:** Update notification shows but no "Upgrade Now" button

**Solutions:**

1. **Check if watchdog is running:**
   ```bash
   docker ps | grep upgrader
   ```

2. **Verify environment variable:**
   ```bash
   docker exec meshmonitor env | grep AUTO_UPGRADE_ENABLED
   ```
   Should output: `AUTO_UPGRADE_ENABLED=true`

3. **Restart with upgrade overlay:**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d
   ```

### Upgrade Fails Immediately

**Problem:** Upgrade fails with pre-flight check errors

**Solutions:**

1. **Check disk space:**
   ```bash
   df -h /var/lib/docker
   ```
   Need at least 500MB free

2. **Check backup directory permissions:**
   ```bash
   docker exec meshmonitor ls -la /data/backups
   ```

3. **Manually create backup directory:**
   ```bash
   docker exec meshmonitor mkdir -p /data/backups
   ```

### Upgrade Stuck at "Restarting"

**Problem:** Upgrade progress shows "Restarting services..." but never completes

**Solutions:**

1. **Check watchdog logs:**
   ```bash
   docker logs meshmonitor-upgrader
   ```

2. **Check main container logs:**
   ```bash
   docker logs meshmonitor
   ```

3. **Verify Docker socket access:**
   ```bash
   docker exec meshmonitor-upgrader docker ps
   ```

4. **Manually restart if needed:**
   ```bash
   docker compose restart meshmonitor
   ```

### Upgrade Stuck in "In Progress" State

**Problem:** UI shows "Upgrade already in progress" but upgrade has been stuck for a long time

**Automatic Recovery:** The system automatically detects and cleans up stale upgrades after 30 minutes. Any upgrade stuck in progress for more than 30 minutes will be automatically marked as failed and the system will be ready for a new upgrade attempt.

**Manual Recovery:**

1. **Check if upgrade is actually running:**
   ```bash
   docker logs meshmonitor-upgrader --tail 50
   ```

2. **Force cancel if needed:**
   ```bash
   # Remove trigger file
   docker exec meshmonitor rm -f /data/.upgrade-trigger

   # Update database to mark as failed (requires SQL access)
   docker exec meshmonitor sqlite3 /data/meshmonitor.db \
     "UPDATE upgrade_history SET status='failed', completedAt=$(date +%s)000 \
      WHERE status IN ('pending','backing_up','downloading','restarting','health_check')"
   ```

3. **Restart services:**
   ```bash
   docker compose restart meshmonitor
   ```

### Container Won't Start After Upgrade

**Problem:** New version fails health checks

**Automatic Rollback:** The watchdog automatically rolls back to the previous version if health checks fail.

**Manual Rollback:**

1. **Stop current version:**
   ```bash
   docker compose stop meshmonitor
   ```

2. **Use previous image tag:**
   ```bash
   docker tag ghcr.io/yeraze/meshmonitor:2.13.4 ghcr.io/yeraze/meshmonitor:latest
   ```

3. **Restore backup:**
   ```bash
   docker run --rm -v meshmonitor-data:/data -v $(pwd)/backups:/backups \
     alpine sh -c "cd /data && tar xzf /backups/upgrade-backup-*.tar.gz"
   ```

4. **Restart:**
   ```bash
   docker compose up -d meshmonitor
   ```

### Watchdog Not Detecting Trigger

**Problem:** Clicked "Upgrade Now" but nothing happens

**Solutions:**

1. **Check trigger file exists:**
   ```bash
   docker exec meshmonitor ls -la /data/.upgrade-trigger
   ```

2. **Check watchdog is monitoring:**
   ```bash
   docker logs meshmonitor-upgrader | grep "Monitoring"
   ```

3. **Manually trigger (for testing):**
   ```bash
   docker exec meshmonitor sh -c 'echo "{\"version\":\"latest\"}" > /data/.upgrade-trigger'
   ```

## Security Considerations

### Docker Socket Access

The watchdog sidecar requires access to the Docker socket (`/var/run/docker.sock`) to manage containers. This grants it **full control** over Docker on the host.

**Security Measures:**

1. **Isolated Container:** The watchdog runs as a separate container with minimal permissions
2. **Read-Only Scripts:** Upgrade scripts are mounted read-only
3. **Limited Scope:** Only manages the `meshmonitor` container
4. **No Network Access:** The watchdog doesn't need network connectivity

**Alternative (More Secure):** Use a remote Docker API with TLS authentication instead of mounting the socket.

### Backup Security

Backups contain your entire database and configuration, including:

- User credentials (hashed)
- Session data
- Node information
- Messages

**Recommendations:**

- Store backups on encrypted volumes
- Regularly clean old backups
- Restrict file permissions: `chmod 600 /data/backups/*.tar.gz`

## Best Practices

### 1. Test Upgrades in Staging

Before upgrading production:

1. Deploy a staging instance with same data
2. Test the upgrade process
3. Verify application functionality
4. Check for breaking changes in release notes

### 2. Schedule Upgrades During Low Usage

- Upgrade during maintenance windows
- Notify users of brief downtime
- Monitor application after upgrade

### 3. Keep Multiple Backups

The system keeps only the most recent backup. For production:

```bash
# Create manual backup before upgrade
docker exec meshmonitor sh -c 'tar czf /data/backups/pre-upgrade-$(date +%Y%m%d).tar.gz -C /data .'
```

### 4. Monitor Logs

Watch logs during upgrade:

```bash
# Terminal 1: Watchdog logs
docker logs -f meshmonitor-upgrader

# Terminal 2: Application logs
docker logs -f meshmonitor
```

### 5. Verify After Upgrade

After successful upgrade:

- ✅ Check application version in UI
- ✅ Test core functionality
- ✅ Verify WebSocket connections
- ✅ Check node connectivity
- ✅ Review error logs

## Kubernetes Alternative

For Kubernetes deployments, use standard update mechanisms instead:

### Rolling Update via kubectl

```bash
# Update image tag
kubectl set image deployment/meshmonitor meshmonitor=ghcr.io/yeraze/meshmonitor:2.14.0

# Watch rollout
kubectl rollout status deployment/meshmonitor

# Rollback if needed
kubectl rollout undo deployment/meshmonitor
```

### Helm Upgrade

```bash
# Upgrade with new values
helm upgrade meshmonitor ./helm/meshmonitor \
  --set image.tag=2.14.0 \
  --reuse-values

# Rollback if needed
helm rollback meshmonitor
```

## API Reference

### Check Upgrade Status

```http
GET /api/upgrade/status
```

**Response:**
```json
{
  "enabled": true,
  "deploymentMethod": "docker",
  "currentVersion": "2.13.4"
}
```

### Trigger Upgrade

```http
POST /api/upgrade/trigger
Content-Type: application/json

{
  "targetVersion": "2.14.0",
  "backup": true,
  "force": false
}
```

**Response:**
```json
{
  "success": true,
  "upgradeId": "550e8400-e29b-41d4-a716-446655440000",
  "currentVersion": "2.13.4",
  "targetVersion": "2.14.0",
  "message": "Upgrade initiated"
}
```

### Get Upgrade Progress

```http
GET /api/upgrade/status/{upgradeId}
```

**Response:**
```json
{
  "upgradeId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "restarting",
  "progress": 60,
  "currentStep": "Recreating container",
  "logs": [
    "Upgrade initiated",
    "Backup created",
    "Image pulled",
    "Container stopped"
  ],
  "startedAt": "2025-01-07T14:30:22Z",
  "fromVersion": "2.13.4",
  "toVersion": "2.14.0"
}
```

### View Upgrade History

```http
GET /api/upgrade/history?limit=10
```

**Response:**
```json
{
  "history": [
    {
      "upgradeId": "...",
      "status": "complete",
      "fromVersion": "2.13.3",
      "toVersion": "2.13.4",
      "startedAt": "2025-01-05T10:00:00Z",
      "completedAt": "2025-01-05T10:02:15Z"
    }
  ],
  "count": 1
}
```

## FAQ

### Can I downgrade to an older version?

Yes, specify the target version:

```json
POST /api/upgrade/trigger
{
  "targetVersion": "2.13.0"
}
```

However, **downgrading is not recommended** if database schema has changed.

### Does it work with custom Docker images?

Yes, set the `IMAGE_NAME` environment variable in the watchdog:

```yaml
environment:
  - IMAGE_NAME=myregistry.com/my-meshmonitor
```

### Can I disable backups?

Yes, but **not recommended**:

```json
POST /api/upgrade/trigger
{
  "backup": false
}
```

### What happens to my data during upgrade?

- All data in `/data` volume is preserved
- Database connections are gracefully closed
- Active WebSocket connections are disconnected
- Data is backed up before upgrade

### How long does an upgrade take?

Typical upgrade timeline:

- **Backup:** 5-10 seconds
- **Image Pull:** 10-30 seconds (depends on network)
- **Container Restart:** 5-10 seconds
- **Health Check:** 5-10 seconds
- **Total:** 25-60 seconds

## Related Documentation

- [Production Deployment](/configuration/production) - Production setup guide
- [Docker Compose Configurator](/configurator) - Generate Docker configs
