# MeshMonitor Deployment Guide

## Overview

This guide covers various deployment scenarios for MeshMonitor, from development setups to production environments. Choose the method that best fits your needs and infrastructure.

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

### Software Requirements

- **Docker & Docker Compose** (recommended) OR
- **Node.js 20+** (for manual deployment)
- **Meshtastic device** with WiFi/Ethernet and HTTP API enabled

### Network Requirements

- Access to your Meshtastic node's IP address
- Port 8080 available for the web interface (configurable)
- Outbound internet access for initial container downloads

---

## Quick Start (Docker Compose)

The fastest way to get MeshMonitor running is with Docker Compose.

### 1. Create Directory and Files

```bash
mkdir meshmonitor
cd meshmonitor
```

Create `docker-compose.yml`:
```yaml
version: '3.8'

services:
  meshmonitor:
    image: meshmonitor:latest  # Replace with actual image when published
    container_name: meshmonitor
    ports:
      - "8080:3001"
    restart: unless-stopped
    volumes:
      - meshmonitor-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
      - MESHTASTIC_USE_TLS=false

volumes:
  meshmonitor-data:
    driver: local
```

Create `.env` file (optional):
```bash
MESHTASTIC_NODE_IP=192.168.1.100
MESHTASTIC_USE_TLS=false
```

### 2. Deploy

```bash
# Start the application
docker-compose up -d

# Check logs
docker-compose logs -f meshmonitor

# Access the application
open http://localhost:8080
```

### 3. Verify Deployment

1. Open http://localhost:8080 in your browser
2. Check that the connection status shows "connected"
3. Verify that node information appears
4. Test sending a message

---

## Production Docker Deployment

### Docker Compose with Custom Configuration

Create a production-ready `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  meshmonitor:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: meshmonitor
    restart: unless-stopped
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
      - ./logs:/app/logs
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=${MESHTASTIC_NODE_IP}
      - MESHTASTIC_USE_TLS=${MESHTASTIC_USE_TLS:-false}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    labels:
      - "com.meshmonitor.service=meshmonitor"
      - "com.meshmonitor.version=1.0.0"

volumes:
  meshmonitor-data:
    driver: local
    driver_opts:
      o: bind
      type: none
      device: /var/lib/meshmonitor/data
```

### Production Environment Variables

Create `/var/lib/meshmonitor/.env`:
```bash
# Meshtastic Configuration
MESHTASTIC_NODE_IP=192.168.1.100
MESHTASTIC_USE_TLS=false

# Application Configuration
NODE_ENV=production
PORT=3001

# Security (if implementing authentication)
JWT_SECRET=your-super-secure-random-string
SESSION_SECRET=another-secure-random-string

# Logging
LOG_LEVEL=info
LOG_FILE=/app/logs/meshmonitor.log
```

### Deploy to Production

```bash
# Create directories
sudo mkdir -p /var/lib/meshmonitor/{data,logs}
sudo chown -R 1000:1000 /var/lib/meshmonitor

# Deploy
cd /var/lib/meshmonitor
docker-compose -f docker-compose.prod.yml up -d

# Enable auto-restart on boot
sudo systemctl enable docker
```

---

## Manual Node.js Deployment

For environments where Docker isn't available or preferred.

### 1. System Preparation

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nodejs npm build-essential python3

# CentOS/RHEL
sudo dnf install -y nodejs npm gcc-c++ make python3

# macOS
brew install node
```

### 2. Application Setup

```bash
# Clone or extract application
git clone <repository-url> meshmonitor
cd meshmonitor

# Install dependencies
npm install

# Build application
npm run build
npm run build:server

# Create data directory
sudo mkdir -p /var/lib/meshmonitor/data
sudo chown -R $(whoami):$(whoami) /var/lib/meshmonitor
```

### 3. Configuration

Create `/var/lib/meshmonitor/.env`:
```bash
MESHTASTIC_NODE_IP=192.168.1.100
MESHTASTIC_USE_TLS=false
NODE_ENV=production
PORT=3001
```

### 4. Service Setup (systemd)

Create `/etc/systemd/system/meshmonitor.service`:
```ini
[Unit]
Description=MeshMonitor Service
After=network.target

[Service]
Type=simple
User=meshmonitor
WorkingDirectory=/var/lib/meshmonitor/meshmonitor
Environment=NODE_ENV=production
Environment=PORT=3001
EnvironmentFile=/var/lib/meshmonitor/.env
ExecStart=/usr/bin/node dist/server/server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=meshmonitor

[Install]
WantedBy=multi-user.target
```

Create user and start service:
```bash
# Create service user
sudo useradd -r -s /bin/false meshmonitor
sudo chown -R meshmonitor:meshmonitor /var/lib/meshmonitor

# Enable and start service
sudo systemctl daemon-reload
sudo systemctl enable meshmonitor
sudo systemctl start meshmonitor

# Check status
sudo systemctl status meshmonitor
```

---

## Reverse Proxy Setup

### Nginx Configuration

Create `/etc/nginx/sites-available/meshmonitor`:
```nginx
server {
    listen 80;
    server_name meshmonitor.yourdomain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name meshmonitor.yourdomain.com;

    # SSL Configuration
    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security Headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";

    # Gzip Compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

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

        # Timeout settings
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Static file caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:3001;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

Enable the site:
```bash
sudo ln -s /etc/nginx/sites-available/meshmonitor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
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

## Cloud Deployments

### AWS ECS Deployment

1. **Create Task Definition**:
```json
{
  "family": "meshmonitor",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::account:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "meshmonitor",
      "image": "your-ecr-repo/meshmonitor:latest",
      "portMappings": [
        {
          "containerPort": 3001,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "MESHTASTIC_NODE_IP",
          "value": "your-node-ip"
        }
      ],
      "mountPoints": [
        {
          "sourceVolume": "meshmonitor-data",
          "containerPath": "/data"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/meshmonitor",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "volumes": [
    {
      "name": "meshmonitor-data",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-12345678"
      }
    }
  ]
}
```

### DigitalOcean App Platform

Create `app.yaml`:
```yaml
name: meshmonitor
services:
- name: web
  source_dir: /
  github:
    repo: your-username/meshmonitor
    branch: main
  run_command: npm start
  environment_slug: node-js
  instance_count: 1
  instance_size_slug: basic-xxs
  routes:
  - path: /
  env:
  - key: NODE_ENV
    value: production
  - key: MESHTASTIC_NODE_IP
    value: YOUR_NODE_IP
    type: SECRET
```

### Railway Deployment

1. Connect your GitHub repository
2. Set environment variables:
   - `MESHTASTIC_NODE_IP`
   - `NODE_ENV=production`
3. Railway will automatically detect and deploy

---

## unRAID Deployment

MeshMonitor provides a native unRAID template for easy deployment via Community Applications.

### Installation via Community Applications

1. **Install Community Applications Plugin** (if not already installed):
   - Go to **Plugins** → **Apps** tab
   - Search for "Community Applications"
   - Install the plugin

2. **Install MeshMonitor**:
   - Click **Apps** in the unRAID toolbar
   - Search for "MeshMonitor"
   - Click **Install**

3. **Configure Required Settings**:
   - **Meshtastic Node IP**: Your Meshtastic device's IP address
   - **Session Secret**: Generate with `openssl rand -hex 32`
   - **Allowed Origins**: Your unRAID server URL (e.g., `http://192.168.1.50:8080`)
   - **WebUI Port**: Default 8080 (change if needed)

4. **Apply and Start**:
   - Review settings and click **Apply**
   - Access MeshMonitor at `http://[UNRAID-IP]:[PORT]`

### Auto-Update Configuration

MeshMonitor supports auto-updates on unRAID:

- **Recommended**: Use the CA Auto Update Applications plugin
- **Alternative**: Use unRAID's built-in Docker update checking
- **Advanced**: Enable in-app auto-upgrade (requires Docker socket access)

### Full Documentation

For detailed configuration, reverse proxy setup, troubleshooting, and advanced features, see:
- [UNRAID_DEPLOYMENT.md](UNRAID_DEPLOYMENT.md) - Complete unRAID deployment guide
- Template location: [`unraid-template.xml`](../../unraid-template.xml)

---

## Monitoring and Maintenance

### Health Checks

```bash
# Basic health check
curl -f http://localhost:8080/api/health

# Detailed system check
curl -s http://localhost:8080/api/stats | jq '.'
```

### Log Management

```bash
# Docker logs
docker-compose logs -f --tail=100 meshmonitor

# System service logs
sudo journalctl -u meshmonitor -f

# Application logs (if configured)
tail -f /var/lib/meshmonitor/logs/meshmonitor.log
```

### Database Maintenance

```bash
# Export data for backup
curl -X POST http://localhost:8080/api/export > backup-$(date +%Y%m%d).json

# Cleanup old messages (older than 30 days)
curl -X POST -H "Content-Type: application/json" \
  -d '{"days": 30}' \
  http://localhost:8080/api/cleanup/messages

# Cleanup inactive nodes (older than 90 days)
curl -X POST -H "Content-Type: application/json" \
  -d '{"days": 90}' \
  http://localhost:8080/api/cleanup/nodes
```

### Performance Monitoring

Create monitoring script `monitor.sh`:
```bash
#!/bin/bash

API_URL="http://localhost:8080/api"

# Check health
HEALTH=$(curl -s "$API_URL/health" | jq -r '.status')
if [ "$HEALTH" != "ok" ]; then
  echo "ALERT: MeshMonitor health check failed"
fi

# Check node count
NODE_COUNT=$(curl -s "$API_URL/stats" | jq -r '.nodeCount')
echo "Active nodes: $NODE_COUNT"

# Check message rate
MESSAGE_COUNT=$(curl -s "$API_URL/stats" | jq -r '.messageCount')
echo "Total messages: $MESSAGE_COUNT"

# Check disk usage (Docker volume)
docker system df
```

---

## Security Considerations

### Network Security

1. **Firewall Configuration**:
```bash
# Ubuntu UFW
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 8080/tcp    # MeshMonitor
sudo ufw enable

# iptables
sudo iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

2. **SSL/TLS Setup**: Always use HTTPS in production with reverse proxy
3. **Network Isolation**: Consider running in isolated Docker network

### Application Security

1. **Environment Variables**: Store sensitive data in environment variables
2. **Regular Updates**: Keep Docker images and dependencies updated
3. **Access Control**: Implement authentication if needed
4. **Data Encryption**: Consider encrypting sensitive database content

### Backup Strategy

Create automated backup script:
```bash
#!/bin/bash

BACKUP_DIR="/var/backups/meshmonitor"
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Export application data
curl -X POST http://localhost:8080/api/export > "$BACKUP_DIR/data_$DATE.json"

# Backup Docker volume
docker run --rm -v meshmonitor_meshmonitor-data:/data -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/volume_$DATE.tar.gz" /data

# Cleanup old backups (keep last 30 days)
find "$BACKUP_DIR" -name "*.json" -o -name "*.tar.gz" -mtime +30 -delete

echo "Backup completed: $BACKUP_DIR"
```

Add to crontab:
```bash
# Daily backup at 2 AM
0 2 * * * /usr/local/bin/meshmonitor-backup.sh
```

---

## Troubleshooting

### Common Issues

1. **Cannot connect to Meshtastic node**
   ```bash
   # Test network connectivity
   ping YOUR_NODE_IP
   curl http://YOUR_NODE_IP/api/v1/fromradio
   ```

2. **Database connection errors**
   ```bash
   # Check file permissions
   ls -la /data/meshmonitor.db

   # Check disk space
   df -h
   ```

3. **Port already in use**
   ```bash
   # Find process using port
   sudo lsof -i :8080

   # Change port in docker-compose.yml
   ports:
     - "8081:3001"
   ```

### Debug Mode

Enable debug logging:
```bash
# Docker
docker-compose exec meshmonitor sh
export NODE_ENV=development

# Manual deployment
export NODE_ENV=development
npm run dev:server
```

### Recovery Procedures

1. **Container won't start**:
   ```bash
   docker-compose down
   docker system prune -f
   docker-compose up -d
   ```

2. **Data corruption**:
   ```bash
   # Stop application
   docker-compose down

   # Restore from backup
   docker run --rm -v meshmonitor_meshmonitor-data:/data -v /var/backups/meshmonitor:/backup \
     alpine tar xzf /backup/volume_YYYYMMDD_HHMMSS.tar.gz -C /

   # Restart application
   docker-compose up -d
   ```

This comprehensive deployment guide covers all major deployment scenarios and operational considerations for MeshMonitor.