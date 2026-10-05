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

A system backup holds **every table in the database** except three (listed below). That covers:

- **Sources and mesh data**: sources, Meshtastic nodes, messages, channels, telemetry, traceroutes, neighbors and waypoints
- **MeshCore and Reticulum data**: MeshCore nodes, messages, neighbors, position history and heard repeaters; Reticulum destinations, messages, paths and interfaces
- **Configuration and user state**: users, permissions, settings, automations and their variables, the channel database, custom themes, map preferences, embed profiles, ignore and block lists, saved regions, read state
- **Keys and credentials**: see [A backup is a secret](#a-backup-is-a-secret)
- **History and logs**: packet logs (Meshtastic, MeshCore, MQTT), message delivery events, automation runs, mesh issues, estimated positions, audit log, and the logs the automatic features keep

Three tables are left out on purpose:

| Table | Why it is not in a backup |
|-------|---------------------------|
| `sessions` | Live login sessions. A stolen backup would be a stolen login. |
| `push_subscriptions` | Per-browser push endpoints and their secrets. Browsers register again on the next visit. |
| `backup_history` | The index of device-config backup files, which are not part of a system backup. |

::: warning A restore clears push subscriptions
A restore replaces the `users` table, and the database removes each replaced user's push subscriptions with it. Each browser has to turn push notifications back on. Login sessions are not part of a backup: a restore leaves the sessions of the install you restore onto as they are.
:::

### A backup is a secret

**Store a backup the way you store a password file.** It holds keys and tokens, and some of them are not encrypted:

| What | Table | How it is protected inside the backup |
|------|-------|---------------------------------------|
| Channel keys (PSKs) | `channels`, `channel_database`, `mesh_beacon_offers` | **Not protected.** Stored in the clear. Anyone who reads the backup can decrypt those channels. |
| Account passwords | `users` | bcrypt hashes. MFA secrets are stored as the database holds them. |
| API tokens | `api_tokens` | bcrypt hash of each token. The token itself is never stored. |
| PKI private keys (direct-message decryption) | `source_pki_keys` | AES-256-GCM, keyed from `SESSION_SECRET` |
| Analyzer Observer signing keys | `meshcore_observer_keys` | AES-256-GCM, keyed from `SESSION_SECRET` |
| Analyzer Observer broker passwords | `meshcore_observer_credentials` | AES-256-GCM, keyed from `SESSION_SECRET` |
| Saved MeshCore repeater and room passwords | `meshcore_nodes` | AES-256-GCM, keyed from `SESSION_SECRET` |

`SESSION_SECRET` is **not** in the backup. Keep it somewhere else: a backup plus the `SESSION_SECRET` it was made under opens every row in the table above.

What stands between a backup and a reader:

- **On disk**: MeshMonitor creates each backup directory with mode `0700` and each file with mode `0600`, owned by the user the server runs as. Anyone with root on the host, or access to the Docker volume, can still read them.
- **Over the API**: only an **admin** can download a backup. Creating, listing and deleting backups need the `configuration` permission.
- **Nothing encrypts the backup itself.** Encrypt the archive before you copy it anywhere you do not control.

### Security & Integrity

- **SHA-256 Checksums**: Every table file has a checksum, verified before a restore
- **Validation**: A restore that fails validation does not start
- **Allowlist**: A restore only touches tables it knows. A table name in a backup that is not on the list is skipped and logged, on SQLite, PostgreSQL and MySQL alike

### Automated Backups

- **Scheduled Backups**: Configure automatic daily backups at your preferred time
- **Retention Policy**: Automatically delete old backups based on your retention settings
- **Background Processing**: Backups run without impacting system performance

## Creating Backups

### Manual Backup via UI

1. Navigate to **Settings** → **System Backup** section
2. Click **Create Backup Now**
3. Wait for confirmation (a few seconds for a small install; a database with millions of rows takes minutes)
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
├── metadata.json          # Format version, timestamp, table list, checksums
├── sources.json
├── users.json             # User accounts (passwords hashed)
├── nodes.json
├── messages.json
├── meshcore_nodes.json
├── automations.json
└── ...                    # One file per backed-up table (80 in all)
```

Every table in a backup is read from the same snapshot of the database, so the tables agree with each other even when the backup takes minutes and the mesh keeps talking. Changes made after the backup starts are not in it.

Each table file is a JSON array with one row per line. MeshMonitor writes and reads these files a batch at a time, so the size of a table does not set how much memory a backup or a restore needs.

### Size

A backup grows with your history. The large tables are the long-lived ones: route segments, telemetry, traceroutes, and the packet logs if you turned them on. As a guide, a database of about 5 million rows (1.8 GB on disk) makes a backup of about 1.9 GB, or about 80 MB once downloaded as `.tar.gz`. Set **Maximum Backups** with that in mind: each kept backup is a full copy.

### Download Backups

Backups can be downloaded as `.tar.gz` archives via:

1. **UI**: Click **Download** next to any backup in the list
2. **API**: `GET /api/system/backup/download/:dirname`

Only an admin can download a backup. See [A backup is a secret](#a-backup-is-a-secret).

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

- **Integrity validation**: SHA-256 checksums are verified before the restore starts
- **All or nothing**: every table is restored in one transaction. If any table fails, the database is left as it was
- **Tables are replaced, not merged**: each table in the backup is emptied and refilled. Rows added since the backup are gone
- **Re-restore protection**: the same backup is not restored again on the next restart

#### Restoring under a different `SESSION_SECRET`

The encrypted keys and passwords in a backup can only be opened with the `SESSION_SECRET` the backup was made under. If you restore onto an install with a different secret:

- The restore still succeeds, and the encrypted rows are **kept**, not deleted
- The log names the affected sources (ids only), and the audit log entry for the restore records them
- Each feature shows its "key rotated" state and asks for the key or password again: PKI direct-message decryption, the Analyzer Observer key and broker login, saved MeshCore repeater passwords

Set `SESSION_SECRET` back to the original value and restart, and the kept rows work again. Password hashes, API tokens and channel keys do not depend on `SESSION_SECRET`.

#### Restoring an older backup

A backup made before MeshMonitor backed up every table holds 28 tables. Restoring one:

- replaces those 28 tables;
- leaves every other table **as it is** on the install you restore onto. On a fresh install that means empty;
- with one exception: tables that belong to a source or a user (waypoints, ignore and block lists, API tokens, channel database permissions, map preferences) are cleared, because the database removes a source's or user's rows when that source or user is replaced. This has always been so.

A backup that lacks a column added by a later version restores fine: the column takes its default.

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

- **Treat a backup as a secret.** It holds channel keys in the clear, password and token hashes, and encrypted private keys. See [A backup is a secret](#a-backup-is-a-secret)
- **Keep `SESSION_SECRET` apart from the backup.** Together they open every encrypted key in it
- **Transport**: Use HTTPS when downloading backups over the network
- **Storage**: Encrypt the archive before storing it off the host
- **Audit Trail**: Backup, download, delete and restore are all recorded in the audit log

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

- **Normal**: A restore takes time in step with the row count. Millions of rows take minutes
- **Performance**: Restore runs in a single transaction for atomicity
- **Monitoring**: Check container logs for progress messages

## API Reference

### Create Backup

```
POST /api/system/backup
Authorization: Required (configuration:write permission)
```

The request returns when the backup is on disk, which can take minutes on a large database. Only one backup runs at a time: a second request while one is running gets `409` with code `BACKUP_IN_PROGRESS`.

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
Authorization: Required (admin)
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

- [Disaster Recovery Guide](https://github.com/Yeraze/meshmonitor/blob/main/docs/operations/disaster-recovery.md) - Complete disaster recovery procedures
- [Settings Documentation](./settings.md) - All system settings including backup configuration
- [Security Features](./security.md) - Security considerations and best practices
