# MeshMonitor Proxmox LXC Deployment Guide

This guide covers deploying MeshMonitor in a Proxmox VE LXC container using our pre-built templates.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Installation](#detailed-installation)
- [Configuration](#configuration)
- [Network Setup](#network-setup)
- [Backup and Restore](#backup-and-restore)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Limitations](#limitations)

## Overview

MeshMonitor can be deployed in Proxmox VE using LXC (Linux Containers) as an alternative to Docker. This deployment method provides:

- **Lightweight**: LXC containers have minimal overhead compared to VMs
- **Integrated**: Native Proxmox VE management and monitoring
- **Secure**: Unprivileged containers with systemd process management
- **Simple**: Pre-built templates for easy deployment

**Note**: Docker remains the primary supported deployment method with the most features. LXC is provided as a community-supported alternative for Proxmox users.

## Prerequisites

### Proxmox VE Requirements

- **Proxmox VE**: Version 7.0 or later
- **Storage**: At least 10GB available for container
- **Network**: Bridge network configured (typically `vmbr0`)
- **Resources**:
  - Minimum: 1 CPU core, 512MB RAM
  - Recommended: 2 CPU cores, 2GB RAM

### Meshtastic Requirements

- Meshtastic node accessible via TCP/IP
- Node IP address and port (default: 4403)
- Network connectivity between container and node

## Quick Start

```bash
# 1. Download template on your computer
wget https://github.com/jeremiah-k/meshmonitor/releases/latest/download/meshmonitor-latest-amd64.tar.gz

# 2. Upload to Proxmox server
scp meshmonitor-latest-amd64.tar.gz root@YOUR-PROXMOX-IP:/var/lib/vz/template/cache/

# 3. Create container via Proxmox web UI (see Detailed Installation below)

# 4. Start container and configure
pct start CONTAINER-ID
pct enter CONTAINER-ID

# 5. Edit configuration
nano /etc/meshmonitor/meshmonitor.env
# Set: MESHTASTIC_NODE_IP=YOUR-NODE-IP

# 6. Start services
systemctl start meshmonitor
systemctl start meshmonitor-apprise

# 7. Access web UI
# Open browser to: http://CONTAINER-IP:8080
```

## Detailed Installation

### Step 1: Download the LXC Template

1. Go to the [MeshMonitor Releases](https://github.com/jeremiah-k/meshmonitor/releases) page
2. Download the latest `meshmonitor-*-amd64.tar.gz` file
3. Optionally download the `.sha256` file to verify integrity

**Verify checksum (optional)**:
```bash
sha256sum -c meshmonitor-latest-amd64.tar.gz.sha256
```

### Step 2: Upload Template to Proxmox

Upload the template to your Proxmox server's template storage:

```bash
scp meshmonitor-latest-amd64.tar.gz root@YOUR-PROXMOX-IP:/var/lib/vz/template/cache/
```

### Step 3: Create Container from Template

#### Via Proxmox Web UI:

1. **Navigate**: Datacenter → Node → Create CT (top-right button)

2. **General Tab**:
   - **CT ID**: Choose an available ID (e.g., 100)
   - **Hostname**: `meshmonitor`
   - **Unprivileged container**: ✓ Checked (recommended)
   - **Password**: Set a root password
   - **SSH public key**: (optional)

3. **Template Tab**:
   - **Storage**: `local`
   - **Template**: Select `meshmonitor-latest-amd64.tar.gz`

4. **Disks Tab**:
   - **Storage**: Choose your storage (e.g., `local-lxc`)
   - **Disk size**: `10 GiB` (minimum), `20 GiB` (recommended)

5. **CPU Tab**:
   - **Cores**: `2` (recommended)

6. **Memory Tab**:
   - **Memory (MiB)**: `2048` (recommended)
   - **Swap (MiB)**: `512` (optional)

7. **Network Tab**:
   - **Name**: `eth0`
   - **Bridge**: `vmbr0` (your network bridge)
   - **IPv4**: DHCP or Static IP
   - **IPv6**: DHCP or Static IP (optional)
   - **Firewall**: ✓ Checked (optional)

8. **DNS Tab**:
   - Use host settings (default)

9. **Confirm Tab**:
   - Review settings
   - ✓ **Start after created** (recommended)
   - Click **Finish**

#### Via Command Line:

```bash
# Create container
pct create 100 local:vztmpl/meshmonitor-latest-amd64.tar.gz \
  --hostname meshmonitor \
  --cores 2 \
  --memory 2048 \
  --swap 512 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --storage local-lxc \
  --rootfs local-lxc:10 \
  --unprivileged 1 \
  --features nesting=0 \
  --onboot 1

# Start container
pct start 100
```

### Step 4: Initial Configuration

Enter the container:

```bash
pct enter 100  # Replace 100 with your container ID
```

Or SSH into the container:

```bash
ssh root@CONTAINER-IP
```

Configure MeshMonitor:

```bash
# Edit environment file
nano /etc/meshmonitor/meshmonitor.env

# Required: Set your Meshtastic node IP
MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP

# Optional: Set TCP port if not default
MESHTASTIC_TCP_PORT=4403

# Optional: Other configuration (see Configuration section)
```

Start services:

```bash
systemctl start meshmonitor
systemctl start meshmonitor-apprise
```

Verify services are running:

```bash
systemctl status meshmonitor
systemctl status meshmonitor-apprise
```

### Step 5: Access Web UI

1. Find your container's IP address:
   ```bash
   hostname -I
   ```

2. Open web browser to:
   ```
   http://CONTAINER-IP:8080
   ```

3. Log in with default credentials or create first admin user

## Configuration

### Environment Variables

All configuration is done via `/etc/meshmonitor/meshmonitor.env`.

**Example configuration file:**

```bash
# Required
MESHTASTIC_NODE_IP=192.168.1.100

# Optional - Server
PORT=3001
NODE_ENV=production
BASE_URL=/

# Optional - Database
DATABASE_PATH=/data/meshmonitor.db

# Optional - Security
SESSION_SECRET=your-random-secret-here
COOKIE_SECURE=false
COOKIE_SAMESITE=lax

# Optional - CORS
ALLOWED_ORIGINS=http://localhost:8080

# Optional - Virtual Node (for mobile apps)
ENABLE_VIRTUAL_NODE=false
VIRTUAL_NODE_PORT=4404

# Optional - Notifications
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:your@email.com

# Optional - SSO/OIDC
OIDC_ISSUER=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=

# Optional - Logging
ACCESS_LOG_ENABLED=false
ACCESS_LOG_PATH=/data/logs/access.log
ACCESS_LOG_FORMAT=combined
```

### Applying Configuration Changes

After editing `/etc/meshmonitor/meshmonitor.env`:

```bash
systemctl restart meshmonitor
systemctl restart meshmonitor-apprise
```

### Data Directory

All persistent data is stored in `/data`:

```
/data/
├── meshmonitor.db          # SQLite database
├── apprise-config/         # Notification configurations
├── scripts/                # Deployment scripts
├── logs/                   # Application logs
└── system-backups/         # System backup files
```

## Network Setup

### Port Forwarding

By default, MeshMonitor runs on port 3001 but the systemd service is configured to proxy to port 8080.

**To access from outside Proxmox**:

1. Configure Proxmox firewall rules
2. Or use port forwarding on your router
3. Or use a reverse proxy (see below)

### Reverse Proxy (HTTPS)

For production deployments with HTTPS, configure a reverse proxy on the Proxmox host or another server.

**Example nginx configuration:**

```nginx
server {
    listen 80;
    server_name meshmonitor.yourdomain.com;

    location / {
        proxy_pass http://CONTAINER-IP:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable HTTPS with Let's Encrypt:

```bash
certbot --nginx -d meshmonitor.yourdomain.com
```

Update MeshMonitor environment:

```bash
# In /etc/meshmonitor/meshmonitor.env
TRUST_PROXY=true
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://meshmonitor.yourdomain.com
```

## Backup and Restore

### Proxmox Snapshots

The easiest way to backup your MeshMonitor container:

```bash
# Create snapshot
pct snapshot 100 before-update --description "Before updating MeshMonitor"

# List snapshots
pct listsnapshot 100

# Restore snapshot
pct rollback 100 before-update

# Delete snapshot
pct delsnapshot 100 before-update
```

### Manual Database Backup

Backup the SQLite database:

```bash
# Inside container
sqlite3 /data/meshmonitor.db ".backup /data/system-backups/meshmonitor-$(date +%Y%m%d).db"

# Or copy via Proxmox host
pct exec 100 -- sqlite3 /data/meshmonitor.db ".backup /data/system-backups/meshmonitor-backup.db"
```

### System Backup via Web UI

MeshMonitor includes a built-in backup feature accessible via the web UI:

1. Navigate to **Settings** → **System Backup**
2. Click **Create Backup**
3. Download the backup file
4. Restore via **Upload Backup**

### Full Container Backup

Backup entire container to file:

```bash
# On Proxmox host
vzdump 100 --storage local --compress gzip --mode snapshot
```

## Troubleshooting

### Service Status

Check service status:

```bash
systemctl status meshmonitor
systemctl status meshmonitor-apprise
```

### View Logs

Real-time logs:

```bash
# MeshMonitor application logs
journalctl -u meshmonitor -f

# Apprise notification logs
journalctl -u meshmonitor-apprise -f

# All MeshMonitor logs
journalctl -t meshmonitor -f
```

Historical logs:

```bash
# Last 100 lines
journalctl -u meshmonitor -n 100

# Since specific time
journalctl -u meshmonitor --since "1 hour ago"

# Filter by priority
journalctl -u meshmonitor -p err
```

### Common Issues

#### Service Won't Start

**Check configuration**:
```bash
nano /etc/meshmonitor/meshmonitor.env
# Verify MESHTASTIC_NODE_IP is set correctly
```

**Check file permissions**:
```bash
ls -la /data
chown -R meshmonitor:meshmonitor /data
```

**Check systemd service**:
```bash
systemctl cat meshmonitor
systemd-analyze verify meshmonitor.service
```

#### Cannot Connect to Meshtastic Node

**Test network connectivity**:
```bash
# Inside container
ping YOUR-NODE-IP
nc -zv YOUR-NODE-IP 4403
```

**Check firewall**:
```bash
# On Proxmox host
pct config 100 | grep firewall

# Verify Meshtastic node is listening
# On node device:
netstat -tln | grep 4403
```

#### Web UI Not Accessible

**Check service is running**:
```bash
systemctl status meshmonitor
netstat -tln | grep 3001
```

**Check from Proxmox host**:
```bash
curl http://CONTAINER-IP:8080
```

**Verify network configuration**:
```bash
ip addr show
ip route show
```

#### Database Locked Errors

**Check for stale processes**:
```bash
ps aux | grep node
lsof /data/meshmonitor.db
```

**Restart services**:
```bash
systemctl restart meshmonitor
```

### Performance Issues

**Check resource usage**:
```bash
# CPU and memory
top
htop

# Disk I/O
iotop

# Database size
du -sh /data/meshmonitor.db
```

**Increase container resources** (on Proxmox host):
```bash
pct set 100 --cores 4
pct set 100 --memory 4096
```

## Updating

### Manual Update Process

LXC deployments do not support auto-upgrade. To update:

1. **Create snapshot** before updating:
   ```bash
   pct snapshot 100 before-update-v2.19.5
   ```

2. **Download new template**:
   ```bash
   wget https://github.com/jeremiah-k/meshmonitor/releases/download/v2.19.5/meshmonitor-2.19.5-amd64.tar.gz
   ```

3. **Upload to Proxmox**:
   ```bash
   scp meshmonitor-2.19.5-amd64.tar.gz root@proxmox:/var/lib/vz/template/cache/
   ```

4. **Backup data**:
   ```bash
   pct exec 100 -- tar czf /tmp/meshmonitor-data-backup.tar.gz /data
   pct pull 100 /tmp/meshmonitor-data-backup.tar.gz ./meshmonitor-data-backup.tar.gz
   ```

5. **Stop and destroy old container**:
   ```bash
   pct stop 100
   pct destroy 100
   ```

6. **Create new container** from updated template (repeat Step 3 from Installation)

7. **Restore data**:
   ```bash
   pct push 100 ./meshmonitor-data-backup.tar.gz /tmp/meshmonitor-data-backup.tar.gz
   pct exec 100 -- tar xzf /tmp/meshmonitor-data-backup.tar.gz -C /
   pct exec 100 -- rm /tmp/meshmonitor-data-backup.tar.gz
   ```

8. **Verify configuration** and start services

**Note**: Future versions may support in-place updates without recreating the container.

## Limitations

### Feature Limitations

- ❌ **No auto-upgrade**: Manual update process required
- ❌ **Single architecture**: amd64/x86_64 only (no ARM support yet)
- ❌ **Community support**: LXC is best-effort, Docker is primary

### Deployment Considerations

- Updates require recreating the container from new template
- Data must be backed up before major updates
- Some Docker-specific features may not be available

### Supported Features

- ✅ Core functionality (node monitoring, messaging, telemetry)
- ✅ Web push notifications
- ✅ Apprise notification integrations
- ✅ System backups and restore
- ✅ OIDC/SSO authentication
- ✅ API access
- ✅ Virtual node for mobile apps

## Additional Resources

- **Main Documentation**: [Getting Started Guide](../getting-started.md)
- **Configuration Guide**: [Production Deployment](../configuration/production.md)
- **Docker Deployment**: [Deployment Guide](./DEPLOYMENT_GUIDE.md)
- **GitHub**: [MeshMonitor Repository](https://github.com/jeremiah-k/meshmonitor)
- **Issues**: [Report Problems](https://github.com/jeremiah-k/meshmonitor/issues)

## Getting Help

If you encounter issues:

1. Check this troubleshooting guide
2. Review the [main documentation](../getting-started.md)
3. Search [existing issues](https://github.com/jeremiah-k/meshmonitor/issues)
4. Ask in [Discussions](https://github.com/jeremiah-k/meshmonitor/discussions)
5. Create a [new issue](https://github.com/jeremiah-k/meshmonitor/issues/new) with:
   - LXC container configuration
   - Service logs (`journalctl -u meshmonitor`)
   - Environment configuration (redact sensitive data)
   - Steps to reproduce the problem
