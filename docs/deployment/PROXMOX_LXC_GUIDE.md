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
- **Updatable**: Templates are git-native from first boot — `meshmonitor-update` handles future in-place upgrades without redeploying

**Note**: Docker remains the primary supported deployment method with the most features. LXC is provided as a community-supported alternative for Proxmox users.

## Prerequisites

### Proxmox VE Requirements

- **Proxmox VE**: Version 7.0 or later
- **Storage**: At least 10GB available for container
- **Network**: Bridge network configured (typically `vmbr0`)
- **Resources**:
  - Minimum: 1 CPU core, 512MB RAM
  - Recommended: 2 CPU cores, 2GB RAM, 1GB swap

### Meshtastic Requirements

- Meshtastic node accessible via TCP/IP
- Network connectivity between container and node
- Node connection is configured via the MeshMonitor web UI after first login

## Quick Start

**Note**: Replace `<version>` with the actual version number from the [releases page](https://github.com/yeraze/meshmonitor/releases) (e.g., `4.12.0`). The generic "latest" URL does not work due to GitHub's asset naming requirements.

```bash
# 1. Download template on your computer
wget https://github.com/yeraze/meshmonitor/releases/download/v<version>/meshmonitor-<version>-amd64.tar.gz

# 2. Upload to Proxmox server
scp meshmonitor-<version>-amd64.tar.gz root@YOUR-PROXMOX-IP:/var/lib/vz/template/cache/

# 3. Create container via Proxmox web UI (see Detailed Installation below)

# 4. Start container and run post-install setup
pct start CONTAINER-ID
pct enter CONTAINER-ID
bash /opt/meshmonitor/lxc/proxmox/post-install.sh

# 5. Access web UI — URL is printed by post-install.sh
# Open browser to: http://CONTAINER-IP:3001
# Default login: admin / changeme (change immediately)
# Configure your Meshtastic node via Settings -> Node Connection
```

## Detailed Installation

### Step 1: Download the LXC Template

1. Go to the [MeshMonitor Releases](https://github.com/yeraze/meshmonitor/releases) page
2. Find the latest release version number (e.g., `v4.12.0`)
3. Download the `meshmonitor-<version>-amd64.tar.gz` file for that version
4. Optionally download the `.sha256` file to verify integrity

**Example download** (replace `<version>` with the current version):
```bash
wget https://github.com/yeraze/meshmonitor/releases/download/v<version>/meshmonitor-<version>-amd64.tar.gz
wget https://github.com/yeraze/meshmonitor/releases/download/v<version>/meshmonitor-<version>-amd64.tar.gz.sha256
```

**Verify checksum (optional)**:
```bash
sha256sum -c meshmonitor-<version>-amd64.tar.gz.sha256
```

### Step 2: Upload Template to Proxmox

Upload the template to your Proxmox server's template storage:

```bash
scp meshmonitor-<version>-amd64.tar.gz root@YOUR-PROXMOX-IP:/var/lib/vz/template/cache/
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
   - **Storage**: Your template storage
   - **Template**: Select `meshmonitor-<version>-amd64.tar.gz`

4. **Disks Tab**:
   - **Storage**: Choose your storage (e.g., `local-lvm`)
   - **Disk size**: `10 GiB` (minimum), `20 GiB` (recommended)

5. **CPU Tab**:
   - **Cores**: `2` (recommended)

6. **Memory Tab**:
   - **Memory (MiB)**: `2048` (recommended)
   - **Swap (MiB)**: `1024` (recommended — needed for npm build during updates)

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
# Create container (replace <version> and <storage> with actual values)
pct create 100 local:vztmpl/meshmonitor-<version>-amd64.tar.gz \
  --hostname meshmonitor \
  --cores 2 \
  --memory 2048 \
  --swap 1024 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --storage <storage> \
  --rootfs <storage>:10 \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1

# Start container
pct start 100
```

### Step 4: Post-Install Setup

Enter the container:

```bash
pct enter 100  # Replace 100 with your container ID
```

Run the post-install script:

```bash
bash /opt/meshmonitor/lxc/proxmox/post-install.sh
```

This script:
- Sets `ALLOWED_ORIGINS` in `meshmonitor.env` with your container's actual IP
- Populates `meshmonitor.env` from the documented example file
- Adds `/usr/local/bin` to PATH for `meshmonitor-update`
- Prints the web UI URL, default login, and update instructions

### Step 5: Access Web UI

1. The post-install script prints your URL — open it in a browser:
   ```
   http://CONTAINER-IP:3001
   ```

2. Log in with default credentials:
   - **Username**: `admin`
   - **Password**: `changeme`
   - Change your password immediately after first login

3. Configure your Meshtastic node:
   - Go to **Settings → Node Connection**
   - Enter your node's IP address and save

## Configuration

### Environment Variables

All configuration is done via `/etc/meshmonitor/meshmonitor.env`. The post-install script
populates this from `meshmonitor.env.example` with `ALLOWED_ORIGINS` pre-set to your
container's IP. Edit it to customize further:

```bash
nano /etc/meshmonitor/meshmonitor.env
```

**Key settings:**

```bash
# CORS — set to your container's IP (post-install.sh sets this automatically)
ALLOWED_ORIGINS=http://CONTAINER-IP:3001

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

See `/etc/meshmonitor/meshmonitor.env.example` for the full documented list of options.

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

MeshMonitor listens on port 3001 by default (configurable via the `PORT` environment variable in `/etc/meshmonitor/meshmonitor.env`).

**To access from outside Proxmox**:

1. Configure Proxmox firewall rules to allow port 3001
2. Or use port forwarding on your router

**Note**: Unlike Docker deployments which map `8080:3001`, LXC containers have no port
mapping layer — the app runs directly on port 3001.

### Static IP Configuration

To assign a static IP via Proxmox web UI:
- Container → Network → Edit → IPv4: Static
- Set IP/CIDR and Gateway

Or via command line on the Proxmox host:
```bash
pct set 100 --net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1
```

## Backup and Restore

### Automated Backup via meshmonitor-update

`meshmonitor-update` creates a backup before every update automatically. Backups are
stored at `/var/backups/meshmonitor/` by default and include `/data/`,
`meshmonitor.env`, and systemd service files.

### Manual Backup

```bash
# Inside container
tar czf /tmp/meshmonitor-backup.tar.gz /data /etc/meshmonitor
```

```bash
# Copy to Proxmox host
pct pull 100 /tmp/meshmonitor-backup.tar.gz ./meshmonitor-backup.tar.gz
```

### Proxmox Snapshot

```bash
# On Proxmox host
pct snapshot 100 pre-update --description "Before update"
```

### Proxmox Backup

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

#### Network Interface DOWN / No IP Address

If `ip addr show` shows `eth0` as `state DOWN` with no IP address, the container's networking service may not be running.

**Check networking service**:
```bash
systemctl status networking
```

**Manually bring up the interface**:
```bash
ifup eth0
```

**Verify DHCP client is installed** (required for `ip=dhcp` configuration):
```bash
which dhclient
```

If `dhclient` is missing, the container was built from an older template before the networking fix. Download the latest template from the [releases page](https://github.com/yeraze/meshmonitor/releases) and recreate the container.

**Verify Proxmox wrote the interface config**:
```bash
ls /etc/network/interfaces.d/
cat /etc/network/interfaces
```

You should see an entry for `eth0` with either `dhcp` or a static IP. If `/etc/network/interfaces.d/` is empty, check your Proxmox container network settings in the web UI.

#### Cannot Connect to Meshtastic Node

Configure your node via the web UI: **Settings → Node Connection**.

**Test network connectivity**:
```bash
# Inside container
ping YOUR-NODE-IP

# Test TCP connection to Meshtastic node
curl -s --connect-timeout 5 telnet://YOUR-NODE-IP:4403 || echo "Connection failed"
```

**Check firewall**:
```bash
# On Proxmox host
pct config 100 | grep firewall
```

#### Web UI Not Accessible

**Check service is running**:
```bash
systemctl status meshmonitor
ss -tln | grep 3001
```

**Check from Proxmox host**:
```bash
curl http://CONTAINER-IP:3001
```

**Verify ALLOWED_ORIGINS is set correctly**:
```bash
grep ALLOWED_ORIGINS /etc/meshmonitor/meshmonitor.env
# Should show: ALLOWED_ORIGINS=http://CONTAINER-IP:3001
# If missing, run: bash /opt/meshmonitor/lxc/proxmox/post-install.sh
```

**Verify network configuration**:
```bash
ip addr show
ip route show
```

#### Native Module Crash on Startup

If MeshMonitor fails to start after a fresh deployment with errors related to `better-sqlite3`, the pre-built native binary may not be compatible with your LXC container's platform. Rebuild it from source:

```bash
systemctl stop meshmonitor
apt update
apt install -y build-essential python3 make g++
cd /opt/meshmonitor
npm rebuild better-sqlite3 --build-from-source
systemctl start meshmonitor
```

Verify it's running:
```bash
systemctl status meshmonitor --no-pager -l
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

#### meshmonitor-update Not Found After Self-Install

If `meshmonitor-update` is not found after running the self-install:

```bash
source /root/.bashrc
# or open a new shell
```

`/usr/local/bin` is not in Debian's minimal default PATH. The self-install adds it
to `/root/.bashrc` automatically, but the current shell session needs to be reloaded.

### Performance Issues

**Check resource usage**:
```bash
# CPU and memory
top

# Database size
du -sh /data/meshmonitor.db
```

**Increase container resources** (on Proxmox host):
```bash
pct set 100 --cores 4
pct set 100 --memory 4096
pct set 100 --swap 1024
```

If `meshmonitor-update` runs for an excessively long time, the container likely needs
more RAM or swap — npm's TypeScript build peaks at ~1.5GB Node heap.

## Updating

Templates built from v4.12.0+ are git-native from first boot. Two update paths are available:

### In-place update (recommended)

Run inside the container — no template redownload, no data migration, minimal downtime:

```bash
# First run — self-installs to /usr/local/bin:
bash /opt/meshmonitor/lxc/meshmonitor-update

# All subsequent runs:
meshmonitor-update

# Useful flags:
meshmonitor-update -s    # check current vs available version
meshmonitor-update -n    # dry run — preview what would change
meshmonitor-update -h    # see all options
```

This performs a `git pull`, rebuilds the app, and restarts services in place.

### Full template swap (alternative)

Use when major OS or Node.js version changes ship, or on containers with limited
resources where the npm build is impractical.

`lxc/update.sh` automates the destroy-and-recreate flow on the Proxmox host:

```bash
# Fetch the script:
wget https://raw.githubusercontent.com/Yeraze/meshmonitor/main/lxc/update.sh
chmod +x update.sh

# Update CT 100 to the latest release (auto-detected):
./update.sh --ctid 100

# Or pin a specific version:
./update.sh --ctid 100 --version 4.12.0

# Non-interactive (e.g. cron):
./update.sh --ctid 100 --yes
```

The script:

- Reads cores/memory/swap/storage/bridge/rootfs size from the existing CT.
- Takes a Proxmox snapshot (best-effort) and writes file backups of `/data` and `/etc/meshmonitor` to `/root/meshmonitor-lxc-backups/`.
- Preserves the current static IP/gateway by default.
- Restarts the MeshMonitor systemd services after the rebuild.

See `./update.sh --help` for all options.

### Manual Update Process

If you prefer to run each step yourself:

1. **Create snapshot** before updating:
   ```bash
   pct snapshot 100 before-update
   ```

2. **Download new template** into Proxmox's template cache:
   ```bash
   wget -O /var/lib/vz/template/cache/meshmonitor-<version>-amd64.tar.gz \
     https://github.com/Yeraze/meshmonitor/releases/download/v<version>/meshmonitor-<version>-amd64.tar.gz
   ```

3. **Back up data and env**:
   ```bash
   pct exec 100 -- tar czf /tmp/meshmonitor-data.tar.gz /data /etc/meshmonitor
   pct pull 100 /tmp/meshmonitor-data.tar.gz ./meshmonitor-data.tar.gz
   ```

4. **Note the current network config**:
   ```bash
   pct config 100 | grep net0
   ```

5. **Stop and destroy** the old container:
   ```bash
   pct stop 100
   pct destroy 100
   ```

6. **Create the new container** from the updated template (re-use the IP from step 4).

7. **Restore data and env**:
   ```bash
   pct push 100 ./meshmonitor-data.tar.gz /tmp/meshmonitor-data.tar.gz
   pct exec 100 -- tar xzf /tmp/meshmonitor-data.tar.gz -C /
   pct exec 100 -- rm /tmp/meshmonitor-data.tar.gz
   pct exec 100 -- chown -R meshmonitor:meshmonitor /data
   ```

8. **Run post-install and restart services**:
   ```bash
   pct exec 100 -- bash /opt/meshmonitor/lxc/proxmox/post-install.sh
   pct exec 100 -- systemctl restart meshmonitor meshmonitor-apprise
   pct exec 100 -- systemctl status meshmonitor --no-pager
   ```

## Limitations

### Feature Limitations

- ✅ **In-place upgrade**: `meshmonitor-update` handles updates from v4.12.0+ templates
- ❌ **Single architecture**: amd64/x86_64 only (no ARM support yet)
- ❌ **Community support**: LXC is best-effort, Docker is primary

### Deployment Considerations

- Templates prior to v4.12.0 had no `.git` and required `migrate-to-git.sh` before `meshmonitor-update` could be used. See the [migration guide](https://gist.github.com/BeerMan81/06c562c32582b14ab7437dfb2ad8cbd0).
- Data and env are preserved across full template swap updates via file backup + restore
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

- **Main Documentation**: [Getting Started Guide](https://meshmonitor.org/getting-started)
- **Configuration Guide**: [Production Deployment](https://meshmonitor.org/configuration/production)
- **Docker Deployment**: [Deployment Guide](https://github.com/Yeraze/meshmonitor/blob/main/docs/deployment/DEPLOYMENT_GUIDE.md)
- **GitHub**: [MeshMonitor Repository](https://github.com/yeraze/meshmonitor)
- **Issues**: [Report Problems](https://github.com/yeraze/meshmonitor/issues)

## Getting Help

If you encounter issues:

1. Check this troubleshooting guide
2. Review the [main documentation](https://meshmonitor.org/getting-started)
3. Search [existing issues](https://github.com/yeraze/meshmonitor/issues)
4. Ask in [Discussions](https://github.com/yeraze/meshmonitor/discussions)
5. Create a [new issue](https://github.com/yeraze/meshmonitor/issues/new) with:
   - LXC container configuration
   - Service logs (`journalctl -u meshmonitor`)
   - Environment configuration (redact sensitive data)
   - Steps to reproduce the problem
