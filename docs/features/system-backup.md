# System Backup & Restore

MeshMonitor provides comprehensive system backup and restore capabilities for disaster recovery, data migration, and archival purposes.

## Overview

The system backup feature exports your entire MeshMonitor database to JSON format, allowing you to:

- **Disaster Recovery**: Restore your complete MeshMonitor instance after hardware failure or data corruption
- **Data Migration**: Move your MeshMonitor installation to new hardware or containers
- **Archival**: Keep historical snapshots of your mesh network data
- **Testing**: Create backups before major upgrades or configuration changes

## Features

### Complete Database Export

System backups include all critical data:

- **Network Data**: Nodes, messages, channels, and waypoints
- **Configuration**: Users, permissions, settings, and automation rules
- **Telemetry**: Device metrics, environment sensors, and solar estimates
- **Security**: Encrypted keys, MQTT credentials (encrypted), and audit logs

### Security & Integrity

- **SHA-256 Checksums**: Every table export includes a checksum for integrity verification
- **Encrypted Secrets**: Sensitive data remains encrypted in backups
- **Validation**: Automatic integrity checks before restore operations
- **Excluded Tables**: Sessions and device-specific data are excluded for security

### Automated Backups

- **Scheduled Backups**: Configure automatic daily backups at your preferred time
- **Retention Policy**: Automatically delete old backups based on your retention settings
- **Background Processing**: Backups run without impacting system performance

## Creating Backups

### Manual Backup via UI

1. Navigate to **Settings** → **System Backup** section
2. Click **Create Backup Now**
3. Wait for confirmation (typically 1-3 seconds for most deployments)
4. Your backup appears in the backup list with timestamp and size

### Manual Backup via API

```bash
# Get CSRF token
CSRF=$(curl -s -c cookies.txt http://localhost:8080/api/csrf-token | jq -r '.csrfToken')

# Login
curl -s -b cookies.txt -c cookies.txt \
  -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"username":"admin","password":"yourpassword"}'

# Create backup
curl -s -b cookies.txt \
  -X POST http://localhost:8080/api/system/backup \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF"
```

### Automated Backups

1. Go to **Settings** → **System Backup**
2. Enable **Automated Backups**
3. Set **Backup Time** (24-hour format, e.g., "02:00" for 2 AM)
4. Set **Maximum Backups** to retain (older backups are automatically deleted)
5. Click **Save Settings**

Backups are created daily at the specified time using your container's timezone (set via `TZ` environment variable).

## Backup Storage

### Location

Backups are stored in `/data/system-backups/` within the container, which maps to:
- Docker volume: `meshmonitor-data` volume at `/var/lib/docker/volumes/meshmonitor_meshmonitor-data/_data/system-backups/`
- Host bind mount: Your configured mount point + `/system-backups/`

### Format

Each backup is a timestamped directory (e.g., `2025-11-08_143026`) containing:

```
2025-11-08_143026/
├── metadata.json          # Backup info: version, timestamp, table count
├── nodes.json            # Network nodes with checksums
├── messages.json         # All messages with checksums
├── channels.json         # Channel configurations
├── users.json            # User accounts (passwords hashed)
├── settings.json         # System settings
├── automation_rules.json # Automation configurations
└── [15 more tables...]   # Complete database export
```

### Download Backups

Backups can be downloaded as `.tar.gz` archives via:

1. **UI**: Click **Download** next to any backup in the list
2. **API**: `GET /api/system/backup/download/:dirname`

The tar.gz file contains the entire backup directory for offline storage.

## Restoring from Backup

### Automatic Restore on Startup

The recommended method for disaster recovery:

1. Ensure your backup is in `/data/system-backups/` directory
2. Set the `RESTORE_FROM_BACKUP` environment variable to your backup directory name
3. Start the container

**docker-compose.yml example:**

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - RESTORE_FROM_BACKUP=2025-11-08_143026
    volumes:
      - meshmonitor-data:/data
```

**Docker CLI example:**

```bash
docker run -d \
  -e RESTORE_FROM_BACKUP=2025-11-08_143026 \
  -v meshmonitor-data:/data \
  -p 8080:3001 \
  ghcr.io/yeraze/meshmonitor:latest
```

The container will:
1. Validate backup integrity (SHA-256 checksums)
2. Check schema compatibility
3. Migrate schema if needed (older backups to newer versions)
4. Atomically restore all tables
5. Start normally with restored data

### Restore Process

The restore operation is **atomic** and **safe**:

- ✅ **Integrity Validation**: SHA-256 checksums verified before restore
- ✅ **Schema Migration**: Automatic migration from older MeshMonitor versions
- ✅ **Rollback Safety**: If restore fails, original database remains intact
- ✅ **Node State Reset**: All node states marked as "unknown" (per best practices)

### Restore Status

After restore completes:

- Container logs show: `✅ System restore completed: X tables, Y rows in Z.XXs`
- All data from backup is available
- Nodes will need to reconnect and update their status
- Admin user credentials from the backup are active

## Best Practices

### Backup Strategy

1. **Before Upgrades**: Always create a backup before upgrading MeshMonitor
2. **Regular Schedule**: Enable automated backups to run daily during low-activity hours
3. **Retention**: Keep at least 7 days of backups (set `maxBackups: 7`)
4. **Off-site Storage**: Periodically download backups and store off-site

### Testing Restores

Periodically test your backup/restore process:

```bash
# 1. Create a test container
docker run -d --name meshmonitor-test \
  -e RESTORE_FROM_BACKUP=2025-11-08_143026 \
  -v meshmonitor-data:/data:ro \
  -p 8081:3001 \
  ghcr.io/yeraze/meshmonitor:latest

# 2. Verify data integrity
curl http://localhost:8081/api/nodes

# 3. Clean up
docker stop meshmonitor-test && docker rm meshmonitor-test
```

### Security Considerations

- **Backup Access**: Backups contain encrypted keys and hashed passwords, but should still be secured
- **Transport**: Use HTTPS when downloading backups over the network
- **Storage**: Encrypt backup archives if storing on untrusted media
- **Audit Trail**: All backup/restore operations are logged in the audit log

## Troubleshooting

### "Backup not found" Error

- **Cause**: RESTORE_FROM_BACKUP points to non-existent directory
- **Solution**: Check `/data/system-backups/` for available backups
- **Check**: Use `docker exec meshmonitor ls /data/system-backups`

### "Integrity validation failed" Error

- **Cause**: Backup files corrupted or modified
- **Solution**: Restore from a different backup or re-create the backup
- **Prevention**: Don't manually edit backup JSON files

### "Schema incompatible" Error

- **Cause**: Backup from much newer MeshMonitor version
- **Solution**: Upgrade MeshMonitor first, then restore
- **Note**: Forward compatibility is not guaranteed

### Restore Takes Long Time

- **Normal**: Large deployments (>10,000 messages) may take 10-30 seconds
- **Performance**: Restore runs in a single transaction for atomicity
- **Monitoring**: Check container logs for progress messages

## API Reference

### Create Backup

```
POST /api/system/backup
Authorization: Required (configuration:write permission)
```

**Response:**
```json
{
  "success": true,
  "dirname": "2025-11-08_143026",
  "message": "System backup created successfully"
}
```

### List Backups

```
GET /api/system/backup/list
Authorization: Required (configuration:read permission)
```

**Response:**
```json
{
  "backups": [
    {
      "dirname": "2025-11-08_143026",
      "timestamp": 1699459826000,
      "size": 2457600,
      "tables": 17
    }
  ]
}
```

### Download Backup

```
GET /api/system/backup/download/:dirname
Authorization: Required (configuration:read permission)
```

**Response:** tar.gz archive stream

### Delete Backup

```
DELETE /api/system/backup/delete/:dirname
Authorization: Required (configuration:write permission)
```

**Response:**
```json
{
  "success": true
}
```

### Get/Set Backup Settings

```
GET /api/system/backup/settings
POST /api/system/backup/settings
Authorization: Required (configuration:read/write permission)
```

**Settings:**
```json
{
  "enabled": true,
  "maxBackups": 7,
  "backupTime": "02:00"
}
```

## See Also

- [Disaster Recovery Guide](../operations/disaster-recovery.md) - Complete disaster recovery procedures
- [Settings Documentation](./settings.md) - All system settings including backup configuration
- [Security Features](./security.md) - Security considerations and best practices
