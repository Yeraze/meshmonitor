# Disaster Recovery Guide

This guide provides step-by-step procedures for recovering from various failure scenarios using MeshMonitor's system backup and restore capabilities.

## Quick Recovery Checklist

Before disaster strikes, ensure you have:

- ✅ **Automated backups enabled** with at least 7 days retention
- ✅ **Recent backup downloaded** and stored off-site
- ✅ **Docker compose file backed up** (your configuration)
- ✅ **Environment variables documented** (.env file backed up)
- ✅ **Tested restore procedure** at least once

## Common Disaster Scenarios

### Scenario 1: Complete Hardware Failure

**Situation**: Your server has failed and you need to restore MeshMonitor to new hardware.

**Prerequisites**:
- Downloaded backup archive (.tar.gz) from old system
- New server with Docker installed
- Your original docker-compose.yml and .env files

**Recovery Steps**:

1. **Set up new server**:
   ```bash
   # Install Docker and Docker Compose if needed
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```

2. **Copy configuration files**:
   ```bash
   mkdir -p ~/meshmonitor
   cd ~/meshmonitor
   # Copy your docker-compose.yml and .env files here
   ```

3. **Create volume and restore backup**:
   ```bash
   # Create the data volume
   docker volume create meshmonitor_meshmonitor-data

   # Extract backup to volume
   docker run --rm \
     -v meshmonitor_meshmonitor-data:/data \
     -v $(pwd):/backup \
     alpine:latest \
     sh -c "mkdir -p /data/system-backups && \
            tar -xzf /backup/meshmonitor-backup-2025-11-08.tar.gz -C /data/system-backups/"
   ```

4. **Update docker-compose.yml**:
   ```yaml
   services:
     meshmonitor:
       image: ghcr.io/yeraze/meshmonitor:latest
       environment:
         - RESTORE_FROM_BACKUP=2025-11-08_143026  # Your backup directory name
       volumes:
         - meshmonitor-data:/data
       # ... rest of your config
   ```

5. **Start container**:
   ```bash
   docker compose up -d
   ```

6. **Verify restore**:
   ```bash
   # Check logs
   docker logs meshmonitor | grep -i restore

   # Should see: "✅ System restore completed: X tables, Y rows..."

   # Test API
   curl http://localhost:8080/api/health
   ```

7. **Remove RESTORE_FROM_BACKUP (optional)**:

   **Automatic Protection**: MeshMonitor automatically prevents re-restoring the same backup on subsequent restarts. A marker file is created at `/data/.restore-completed` after successful restore.

   However, it's best practice to remove the environment variable:
   ```bash
   # Edit docker-compose.yml and remove or comment out:
   # - RESTORE_FROM_BACKUP=2025-11-08_143026

   docker compose up -d
   ```

   **Note**: If you restart without removing this variable, the restore will be safely skipped with a warning message in the logs.

**Recovery Time**: 5-10 minutes

---

### Scenario 2: Database Corruption

**Situation**: Your MeshMonitor database is corrupted but the container and backups are intact.

**Recovery Steps**:

1. **Stop the container**:
   ```bash
   docker compose stop meshmonitor
   ```

2. **Identify latest good backup**:
   ```bash
   docker run --rm \
     -v meshmonitor_meshmonitor-data:/data \
     alpine:latest \
     ls -lh /data/system-backups/
   ```

3. **Add RESTORE_FROM_BACKUP to compose file**:
   ```yaml
   environment:
     - RESTORE_FROM_BACKUP=2025-11-08_143026
   ```

4. **Restart container**:
   ```bash
   docker compose up -d
   ```

5. **Verify and cleanup**:
   ```bash
   # Check restore succeeded
   docker logs meshmonitor | grep "restore completed"

   # Remove RESTORE_FROM_BACKUP and restart
   docker compose up -d
   ```

**Recovery Time**: 2-5 minutes

---

### Scenario 3: Accidental Data Deletion

**Situation**: You accidentally deleted important data and need to restore from a backup.

**Recovery Steps**:

1. **Stop further operations immediately**:
   ```bash
   docker compose stop meshmonitor
   ```

2. **Create a current backup (even if corrupted)**:
   ```bash
   # Start container temporarily to create final backup
   docker compose up -d
   # Wait for startup
   curl -X POST http://localhost:8080/api/system/backup \
     -H "Authorization: Bearer YOUR_TOKEN"
   docker compose stop
   ```

3. **Choose recovery method**:

   **Option A: Full Restore (Recommended)**
   - Follow Scenario 2 steps above
   - All data from backup timestamp will be restored
   - Any data created after backup timestamp will be lost

   **Option B: Selective Recovery (Advanced)**
   - Extract specific tables from backup JSON
   - Manually import using SQL
   - Requires database expertise
   - Risk of data inconsistency

**Recovery Time**: 5-10 minutes (Option A), 30+ minutes (Option B)

---

### Scenario 4: Migration to New Container Version

**Situation**: Upgrading to a new MeshMonitor version after a long period.

**Recovery Steps**:

1. **Create backup on old version**:
   ```bash
   # Via UI: Settings → System Backup → Create Backup Now
   # Or via API:
   curl -X POST http://localhost:8080/api/system/backup \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

2. **Download backup archive**:
   ```bash
   # Via UI: Download button
   # Or via API:
   curl -O http://localhost:8080/api/system/backup/download/2025-11-08_143026 \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

3. **Update image version**:
   ```yaml
   services:
     meshmonitor:
       image: ghcr.io/yeraze/meshmonitor:v2.16.0  # New version
       environment:
         - RESTORE_FROM_BACKUP=2025-11-08_143026
   ```

4. **Start new version**:
   ```bash
   docker compose pull
   docker compose up -d
   ```

5. **Verify migration**:
   ```bash
   # Check logs for schema migration
   docker logs meshmonitor | grep -i "migration\|schema"

   # Should see: "Schema migration required: X → Y"
   # Followed by: "✅ System restore completed..."
   ```

**Recovery Time**: 5-10 minutes

**Note**: Backups are forward-compatible (old backups work with new versions), but not backward-compatible (new backups may not work with old versions).

---

## Advanced Recovery Scenarios

### Recovering with Partial Volume

**Situation**: You have the Docker volume but no recent backup.

**Steps**:
1. Create an immediate backup:
   ```bash
   docker compose up -d
   # Access UI and create backup
   # Download the backup
   ```

2. Store this backup off-site for future recovery

### Cross-Platform Migration

**Situation**: Moving from x86_64 to ARM64 (or vice versa).

**Steps**:
Same as Scenario 1, but ensure you:
- Use the appropriate Docker image for your architecture
- Backup format is architecture-independent
- Encrypted secrets remain compatible

### Recovering from Read-Only Volume

**Situation**: Volume mounted read-only or filesystem corruption.

**Steps**:
1. Extract data using temporary container:
   ```bash
   docker run --rm \
     -v meshmonitor_meshmonitor-data:/source:ro \
     -v $(pwd)/recovery:/dest \
     alpine:latest \
     cp -r /source/system-backups /dest/
   ```

2. Create new volume and restore as per Scenario 1

---

## Recovery Validation

After any recovery, perform these checks:

### 1. Health Check
```bash
curl http://localhost:8080/api/health
# Expected: {"status":"ok","uptime":...}
```

### 2. Authentication Test
```bash
# Login with admin account
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'
```

### 3. Data Integrity
```bash
# Check node count
curl http://localhost:8080/api/nodes | jq 'length'

# Check message count
curl http://localhost:8080/api/messages?limit=10 | jq '.messages | length'

# Check settings
curl http://localhost:8080/api/settings
```

### 4. Audit Log Review
- Navigate to Settings → Security → Audit Log
- Verify restore event is logged
- Check for any errors during restore

---

## Backup Best Practices

### Daily Operations

1. **Monitor Backup Status**:
   - Check Settings → System Backup weekly
   - Verify automated backups are running
   - Ensure disk space is sufficient

2. **Test Restore Quarterly**:
   - Spin up test container with latest backup
   - Verify all data is accessible
   - Document any issues

3. **Off-Site Storage**:
   - Download backups weekly/monthly
   - Store in separate location (cloud storage, NAS)
   - Encrypt backup archives for transport

### Before Major Changes

Always create a backup before:
- Upgrading MeshMonitor version
- Modifying database directly
- Changing authentication configuration
- Adding/removing users with admin privileges
- Bulk automation changes

### Backup Retention Strategy

**Recommended retention schedule**:
- **Daily backups**: Last 7 days
- **Weekly backups**: Last 4 weeks
- **Monthly backups**: Last 12 months

**Implementation**:
```yaml
# In Settings → System Backup
enabled: true
maxBackups: 7         # Keep 7 daily backups
backupTime: "02:00"   # Run at 2 AM

# Manually download backups weekly and monthly for long-term retention
```

---

## Emergency Contacts

Before disaster strikes, document:

1. **Backup Locations**:
   - Local: `/var/lib/docker/volumes/meshmonitor_meshmonitor-data/_data/system-backups/`
   - Off-site: _[Your cloud storage location]_
   - Archive: _[Your archive location]_

2. **Configuration Files**:
   - docker-compose.yml: _[Location]_
   - .env file: _[Location]_
   - MESHTASTIC_HOST: _[IP/hostname]_

3. **Access Credentials**:
   - Admin username: _[Documented in password manager]_
   - Admin password: _[Documented in password manager]_
   - Docker registry: _[If using private registry]_

---

## Troubleshooting Recovery

### "Restore failed: table X has no column Y"

**Cause**: Trying to restore newer backup to older MeshMonitor version

**Solution**: Upgrade MeshMonitor to latest version first

### "Backup directory not found"

**Cause**: RESTORE_FROM_BACKUP path incorrect

**Solution**:
```bash
# List available backups
docker exec meshmonitor ls /data/system-backups

# Fix environment variable with correct dirname
```

### "Integrity validation failed"

**Cause**: Backup corrupted during storage or transfer

**Solution**: Restore from earlier backup or re-download archive

### Container won't start after restore

**Cause**: Incompatible configuration or environment variables

**Solution**:
1. Remove RESTORE_FROM_BACKUP and check logs
2. Verify all required environment variables are set
3. Check docker-compose.yml syntax
4. Review container logs: `docker logs meshmonitor`

### "Restore already completed" warning

**Cause**: RESTORE_FROM_BACKUP is still set after a successful restore

**Explanation**: MeshMonitor automatically prevents re-restoring the same backup to protect against data loss. A marker file tracks the last restored backup.

**To restore again (same backup)**:
```bash
# Remove the marker file
docker exec meshmonitor rm /data/.restore-completed

# Restart container
docker compose restart
```

**To restore a different backup**:
```bash
# Just change the environment variable to a different backup
# in docker-compose.yml, then restart
docker compose up -d
```

---

## See Also

- [System Backup Features](../features/system-backup.md) - Complete backup feature documentation
- [Settings Guide](../features/settings.md) - Configuration options
- [Security Best Practices](../features/security.md) - Securing your backups
