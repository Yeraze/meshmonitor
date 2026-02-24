# MeshMonitor Deployment Guide

## Overview

This guide covers various deployment scenarios for MeshMonitor, from development setups to production environments. Choose the method that best fits your needs and infrastructure.

## Deployment Methods

MeshMonitor supports several deployment options:

- **🐳 Docker Compose** (Recommended) - Easiest setup with auto-upgrade support
- **☸️ Kubernetes/Helm** - Production-grade orchestration
- **📦 Proxmox LXC** - Lightweight containers for Proxmox VE ([separate guide](PROXMOX_LXC_GUIDE.md))
- **🔧 Bare Metal (Node.js)** - Direct deployment without containers

## Prerequisites

### Hardware Requirements

**Minimum Requirements:**
- CPU: 1 core
- RAM: 512MB
- Storage: 1GB free space
- Network: Internet connectivity for initial setup

**Recommended Requirements:**
- CPU: 2+ cores
- RAM: 2GB
- Storage: 10GB free space (for message history)
- Network: Stable connection to Meshtastic node

### Network Requirements

- Access to your Meshtastic node's IP address (TCP port 4403)
- Port 8080 available for the web interface (configurable)
- Outbound internet access for initial setup

---

## Quick Start (Docker Compose)

For the most up-to-date Docker Compose quick start, see the **[Getting Started](/getting-started)** guide. It includes the recommended `docker-compose.yml`, environment variables, and first-login instructions.

The short version:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
    restart: unless-stopped
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
      - ALLOWED_ORIGINS=http://localhost:8080

volumes:
  meshmonitor-data:
    driver: local
```

```bash
docker compose up -d
```

Default login: **admin** / **changeme** — change your password immediately after first login.

For production deployments with HTTPS and reverse proxies, see the [Production Deployment Guide](/configuration/production).

---

## Bare Metal (Node.js) Deployment

For environments where Docker isn't available or preferred, you can run MeshMonitor directly on your system.

### 1. System Requirements

**Required software:**
- **Node.js 20+** (Node.js 24 LTS recommended)
- **npm** (included with Node.js)
- **git** (for cloning the repository and protobuf submodule)
- **Build tools** for compiling native modules (bcrypt, better-sqlite3)
- **Python 3** (for user scripts and Apprise notifications)

### 2. System Preparation

Install the prerequisites for your platform:

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y git build-essential python3 python3-pip python3-venv curl

# Install Node.js 24 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

```bash
# CentOS/RHEL/Fedora
sudo dnf install -y git gcc-c++ make python3 python3-pip curl

# Install Node.js 24 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
```

```bash
# macOS (with Homebrew)
brew install node git python3
```

Verify your Node.js version:
```bash
node --version  # Should be v20.x or higher
npm --version
```

### 3. Application Setup

```bash
# Clone the repository
git clone https://github.com/yeraze/meshmonitor.git
cd meshmonitor

# Initialize the protobuf submodule (required for Meshtastic protocol support)
git submodule update --init --recursive

# Install dependencies
# --legacy-peer-deps is required to resolve peer dependency conflicts
npm install --legacy-peer-deps

# Build the frontend (React application)
npm run build

# Build the backend (Express server)
npm run build:server
```

### 4. Create Data Directory

MeshMonitor stores its SQLite database and other data files in a configurable directory:

```bash
sudo mkdir -p /var/lib/meshmonitor/data
sudo chown -R $(whoami):$(whoami) /var/lib/meshmonitor
```

### 5. Configuration

Copy the example environment file and customize it:

```bash
cp .env.example /var/lib/meshmonitor/.env
```

Edit `/var/lib/meshmonitor/.env` with the essential settings:

```bash
# Meshtastic node connection
MESHTASTIC_NODE_IP=192.168.1.100
MESHTASTIC_TCP_PORT=4403

# Application settings
NODE_ENV=production
PORT=3001

# IMPORTANT: Database path (Docker default is /data/meshmonitor.db)
# For bare metal, point this to your data directory
DATABASE_PATH=/var/lib/meshmonitor/data/meshmonitor.db

# CORS: Set to match how you access the UI
# For direct access on port 3001:
ALLOWED_ORIGINS=http://localhost:3001
# For access via reverse proxy on port 8080:
# ALLOWED_ORIGINS=http://localhost:8080

# Session secret (required for production)
# Generate with: openssl rand -base64 32
SESSION_SECRET=your-secure-random-string-here
```

See the `.env.example` file in the repository for the full list of available environment variables including SSO/OIDC, push notifications, rate limiting, and more.

### 6. Test the Application

Before setting up a service, verify it starts correctly:

```bash
# Load your environment file
set -a; source /var/lib/meshmonitor/.env; set +a

# Start the server
node dist/server/server.js
```

Open `http://localhost:3001` in your browser. Default login: **admin** / **changeme**.

Press `Ctrl+C` to stop after verifying it works.

### 7. Service Setup (systemd)

Create a systemd service for automatic startup:

Create `/etc/systemd/system/meshmonitor.service`:
```ini
[Unit]
Description=MeshMonitor - Meshtastic Monitoring Dashboard
After=network.target

[Service]
Type=simple
User=meshmonitor
Group=meshmonitor
WorkingDirectory=/var/lib/meshmonitor/meshmonitor
EnvironmentFile=/var/lib/meshmonitor/.env
ExecStart=/usr/bin/node dist/server/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=meshmonitor

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/meshmonitor

[Install]
WantedBy=multi-user.target
```

Create the service user and start:
```bash
# Create a dedicated service user
sudo useradd -r -s /usr/sbin/nologin -d /var/lib/meshmonitor meshmonitor

# Set ownership
sudo chown -R meshmonitor:meshmonitor /var/lib/meshmonitor

# Enable and start the service
sudo systemctl daemon-reload
sudo systemctl enable meshmonitor
sudo systemctl start meshmonitor

# Check status
sudo systemctl status meshmonitor

# View logs
sudo journalctl -u meshmonitor -f
```

### 8. Optional: Apprise Notifications

If you want to use Apprise for notifications (email, Slack, Discord, etc.):

```bash
# Create a Python virtual environment
python3 -m venv /opt/apprise-venv

# Install Apprise
/opt/apprise-venv/bin/pip install apprise
```

### 9. Updating

To update a bare metal installation:

```bash
cd /var/lib/meshmonitor/meshmonitor

# Stop the service
sudo systemctl stop meshmonitor

# Pull latest changes
git pull
git submodule update --init --recursive

# Reinstall dependencies and rebuild
npm install --legacy-peer-deps
npm run build
npm run build:server

# Restart the service
sudo systemctl start meshmonitor
```

---

## Reverse Proxy Setup

For detailed reverse proxy configuration (nginx, Caddy, Traefik), see the dedicated [Reverse Proxy guide](/configuration/reverse-proxy).

When using a reverse proxy, remember to set these environment variables:

```bash
TRUST_PROXY=true
ALLOWED_ORIGINS=https://meshmonitor.yourdomain.com
# If using HTTPS:
COOKIE_SECURE=true
```

### Quick Nginx Example

```nginx
server {
    listen 80;
    server_name meshmonitor.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name meshmonitor.yourdomain.com;

    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://localhost:3001;
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

### Traefik Configuration (Docker)

Add labels to your `docker-compose.yml`:
```yaml
services:
  meshmonitor:
    # ... other configuration
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.meshmonitor.rule=Host(`meshmonitor.yourdomain.com`)"
      - "traefik.http.routers.meshmonitor.entrypoints=websecure"
      - "traefik.http.routers.meshmonitor.tls.certresolver=letsencrypt"
      - "traefik.http.services.meshmonitor.loadbalancer.server.port=3001"
    networks:
      - traefik

networks:
  traefik:
    external: true
```

---

## Monitoring and Maintenance

### Log Management

```bash
# Docker logs
docker compose logs -f --tail=100 meshmonitor

# Systemd service logs (bare metal)
sudo journalctl -u meshmonitor -f

# Access logs (if ACCESS_LOG_ENABLED=true)
tail -f /var/lib/meshmonitor/data/logs/access.log
```

### Backups

MeshMonitor has a built-in [System Backup & Restore](/features/system-backup) feature accessible from the admin UI. Use it to create and restore full database backups.

For automated bare metal backups, back up the SQLite database file directly:

```bash
#!/bin/bash
BACKUP_DIR="/var/backups/meshmonitor"
DATE=$(date +%Y%m%d_%H%M%S)
DB_PATH="/var/lib/meshmonitor/data/meshmonitor.db"

mkdir -p "$BACKUP_DIR"

# Use SQLite backup API for a consistent copy
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/meshmonitor-$DATE.db'"
gzip "$BACKUP_DIR/meshmonitor-$DATE.db"

# Cleanup old backups (keep last 30 days)
find "$BACKUP_DIR" -name "*.db.gz" -mtime +30 -delete

echo "Backup completed: meshmonitor-$DATE.db.gz"
```

Add to crontab for daily backups:
```bash
# Daily backup at 2 AM
0 2 * * * /usr/local/bin/meshmonitor-backup.sh
```

For Docker deployments, back up the volume:
```bash
docker run --rm -v meshmonitor_meshmonitor-data:/data -v /var/backups/meshmonitor:/backup \
  alpine tar czf "/backup/volume_$(date +%Y%m%d_%H%M%S).tar.gz" /data
```

---

## Security Considerations

### Network Security

1. **Firewall Configuration**:
```bash
# Ubuntu UFW
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp       # HTTP (if using reverse proxy)
sudo ufw allow 443/tcp      # HTTPS (if using reverse proxy)
sudo ufw enable

# If accessing MeshMonitor directly (no reverse proxy):
sudo ufw allow 3001/tcp     # MeshMonitor
```

2. **SSL/TLS Setup**: Always use HTTPS in production with a reverse proxy
3. **Network Isolation**: Consider running in an isolated network segment

### Application Security

1. **Change the default password** immediately after first login
2. **Set `SESSION_SECRET`** to a strong random value in production
3. **Set `ALLOWED_ORIGINS`** to your exact domain(s)
4. **Keep dependencies updated** with regular `npm update` or Docker image pulls
5. **Consider enabling `DISABLE_ANONYMOUS=true`** to require login for all access

---

## Troubleshooting

### Common Issues

1. **Cannot connect to Meshtastic node**
   ```bash
   # Test TCP connectivity to the node
   telnet YOUR_NODE_IP 4403

   # Or use netcat
   nc -zv YOUR_NODE_IP 4403
   ```

2. **Database connection errors**
   ```bash
   # Check file permissions (bare metal)
   ls -la /var/lib/meshmonitor/data/meshmonitor.db

   # Check disk space
   df -h
   ```

3. **Port already in use**
   ```bash
   # Find process using port
   sudo lsof -i :3001

   # Change port via environment variable
   export PORT=3002
   ```

4. **CORS / Blank page errors**
   - Ensure `ALLOWED_ORIGINS` matches exactly how you access the UI (including port)
   - See the [FAQ](/faq) for detailed CORS troubleshooting

### Bare Metal Debug Mode

```bash
# Stop the service
sudo systemctl stop meshmonitor

# Run in development mode for verbose logging
cd /var/lib/meshmonitor/meshmonitor
set -a; source /var/lib/meshmonitor/.env; set +a
export NODE_ENV=development
node dist/server/server.js
```

### Docker Recovery

```bash
# Container won't start
docker compose down
docker compose up -d

# Reset all data (WARNING: destroys all data)
docker compose down
docker volume rm meshmonitor_meshmonitor-data
docker compose up -d
```
