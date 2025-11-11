# MeshMonitor unRAID Deployment Guide

This guide provides instructions for deploying MeshMonitor on unRAID using the Community Applications (CA) template.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Auto-Upgrade Setup](#auto-upgrade-setup)
- [Advanced Configuration](#advanced-configuration)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Troubleshooting](#troubleshooting)
- [Backup and Restore](#backup-and-restore)

## Quick Tips for Success

**Common First-Time Issues:**
1. **Permission errors?** → Run `chown -R 1000:1000 /mnt/user/appdata/meshmonitor` from unRAID terminal
2. **Blank page or CORS errors?** → Only set **Allowed Origins** if you get errors (leave empty otherwise)
3. **Sessions reset on restart?** → Set **Session Secret** for persistent sessions

## Prerequisites

### Required

1. **unRAID Server** (version 6.9 or later recommended)
2. **Meshtastic Node** with:
   - WiFi or Ethernet connectivity
   - HTTP API enabled
   - Network access from your unRAID server
3. **Network Connectivity** between unRAID and your Meshtastic node

### Recommended

- **Community Applications** plugin installed
- At least **1-2GB** of free storage space
- **Static IP** for your Meshtastic node (or DHCP reservation)

## Installation

### Method 1: Community Applications (Recommended)

1. **Install Community Applications Plugin** (if not already installed):
   - Go to **Plugins** → **Apps** tab
   - Search for "Community Applications"
   - Install the plugin

2. **Search for MeshMonitor**:
   - Click **Apps** in the unRAID toolbar
   - Search for "MeshMonitor"
   - Click the MeshMonitor icon

3. **Install the Template**:
   - Click **Install**
   - Proceed to [Configuration](#configuration) section

### Method 2: Manual Template Installation

1. **Access Template URLs**:
   - Go to **Docker** tab
   - Scroll to bottom and click **Add Container**
   - Click **Template repositories**

2. **Add Repository** (if MeshMonitor is not yet in CA):
   - Add: `https://github.com/Yeraze/meshmonitor`
   - Or use the template URL directly:
     ```
     https://raw.githubusercontent.com/Yeraze/meshmonitor/main/unraid-template.xml
     ```

3. **Select Template**:
   - Choose **MeshMonitor** from the template list
   - Proceed to [Configuration](#configuration) section

### Method 3: Download Template File

1. **Download the Template**:
   ```bash
   wget https://raw.githubusercontent.com/Yeraze/meshmonitor/main/unraid-template.xml
   ```

2. **Import Template**:
   - Go to **Docker** tab
   - Click **Add Container**
   - At the bottom, select **Template**: Choose the downloaded XML file
   - Proceed to [Configuration](#configuration) section

## Configuration

### Required Configuration

When installing MeshMonitor, you **must** configure these settings:

#### 1. WebUI Port (default: 8080)
- Change if port 8080 is already in use
- Access MeshMonitor at: `http://[UNRAID-IP]:[PORT]`

#### 2. Data Directory (default: /mnt/user/appdata/meshmonitor)
- This stores your database, logs, and configuration
- Default location is recommended
- The container runs as UID 1000 (see Troubleshooting section if you get permission errors)

#### 3. Meshtastic Node IP (**REQUIRED**)
- Enter the IP address of your Meshtastic node
- Example: `192.168.1.100`
- Must be accessible from unRAID server

### Recommended Configuration

These settings are optional but recommended:

#### 4. Session Secret (Optional but recommended)
- **Auto-generates if not provided** - sessions will be reset on container restart
- For persistent sessions across restarts, generate a secure random string:
  ```bash
  # From unRAID terminal or SSH:
  openssl rand -hex 32
  ```
- Copy the output and paste into the **Session Secret** field
- **IMPORTANT**: Keep this secret safe and don't share it

#### 5. Allowed Origins (Optional - only needed for CORS issues)
- **Leave EMPTY for most installations** - defaults to `http://localhost:8080` and `http://localhost:3001`
- **Only set this if you get CORS errors or blank pages**
- When needed, set to your access URL:
  - Local access: `http://192.168.1.50:8080` (replace with your unRAID server IP and port)
  - With domain: `https://meshmonitor.yourdomain.com`
  - Multiple origins: `http://192.168.1.50:8080,https://meshmonitor.yourdomain.com`

### Optional Configuration

#### Timezone
- Set your local timezone (e.g., `America/New_York`, `Europe/London`)
- Find your timezone: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones

#### Admin Username
- Default: `admin`
- Change to your preferred admin username

#### Disable Anonymous Access
- Set to `true` to require login for all features
- Set to `false` (default) to allow read-only anonymous access

### Click Apply

- Review your settings
- Click **Apply** to create and start the container

## First-Time Setup

1. **Access the Web Interface**:
   - Navigate to: `http://[UNRAID-IP]:[PORT]`
   - Example: `http://192.168.1.50:8080`

2. **Initial Login**:
   - If you haven't disabled anonymous access, you can browse immediately
   - To access admin features, click **Login** and create your admin account

3. **Verify Connection**:
   - The dashboard should show your mesh network
   - Check that nodes are appearing
   - Verify telemetry data is being collected

4. **Configure Notifications** (optional):
   - Go to **Settings** → **Notifications**
   - Add Apprise notification URLs for alerts
   - Supports 100+ services (Discord, Slack, Email, Pushover, etc.)

## Auto-Upgrade Setup

MeshMonitor supports automatic updates directly from the UI. However, on unRAID, we recommend using the built-in Docker update mechanisms.

### Method 1: unRAID Auto-Update (Recommended)

1. **Install CA Auto Update Applications Plugin**:
   - Go to **Plugins** → **Apps**
   - Search for "Auto Update Applications"
   - Install the plugin

2. **Configure Auto-Update**:
   - Go to **Plugins** → **Auto Update Applications**
   - Enable auto-update for MeshMonitor
   - Set your preferred schedule

3. **Enable Notifications**:
   - Configure notification settings to receive update alerts

### Method 2: Manual Updates

1. **Check for Updates**:
   - Go to **Docker** tab
   - Look for "Update Available" badge on MeshMonitor

2. **Update the Container**:
   - Click the MeshMonitor icon
   - Select **Force Update**
   - Container will be recreated with the latest image

### Method 3: In-App Updates (Advanced)

**WARNING**: This method requires mounting the Docker socket and may have security implications.

To enable in-app auto-upgrade:

1. **Edit Container**:
   - Go to **Docker** tab
   - Click MeshMonitor icon → **Edit**

2. **Add Docker Socket Mount**:
   - Scroll to bottom and click **Add another Path, Port, Variable, Label or Device**
   - Set:
     - **Config Type**: Path
     - **Name**: Docker Socket
     - **Container Path**: `/var/run/docker.sock`
     - **Host Path**: `/var/run/docker.sock`
     - **Access Mode**: Read/Write

3. **Apply Changes**:
   - Click **Apply**
   - Container will be recreated

4. **Enable Auto-Upgrade in UI**:
   - Access MeshMonitor web interface
   - Go to **Settings** → **System**
   - Enable **Auto-Upgrade**
   - Click **Check for Updates** to verify

**Note**: This grants the container access to Docker. Only enable if you understand the security implications.

## Advanced Configuration

### HTTPS with Reverse Proxy

For secure access, use a reverse proxy like nginx, Swag, or Caddy.

#### Using Swag (Secure Web Application Gateway)

1. **Install Swag**:
   - From Community Applications, install **swag**

2. **Configure Swag**:
   - Set up your domain and SSL certificates
   - Create a proxy config for MeshMonitor

3. **Create MeshMonitor Proxy Config**:
   ```nginx
   # /mnt/user/appdata/swag/nginx/proxy-confs/meshmonitor.subdomain.conf
   server {
       listen 443 ssl http2;
       listen [::]:443 ssl http2;

       server_name meshmonitor.*;

       include /config/nginx/ssl.conf;

       client_max_body_size 0;

       location / {
           include /config/nginx/proxy.conf;
           resolver 127.0.0.11 valid=30s;
           set $upstream_app meshmonitor;
           set $upstream_port 3001;
           set $upstream_proto http;
           proxy_pass $upstream_proto://$upstream_app:$upstream_port;
       }
   }
   ```

4. **Update MeshMonitor Configuration**:
   - Edit MeshMonitor container
   - Set **Allowed Origins**: `https://meshmonitor.yourdomain.com`
   - Set **Cookie Secure**: `true`
   - Set **Trust Proxy**: `true`
   - Apply changes

#### Using Nginx Proxy Manager

1. **Install Nginx Proxy Manager**:
   - From Community Applications, install **NginxProxyManager**

2. **Add Proxy Host**:
   - Go to **Proxy Hosts** → **Add Proxy Host**
   - **Domain Names**: `meshmonitor.yourdomain.com`
   - **Scheme**: `http`
   - **Forward Hostname/IP**: `[UNRAID-IP]` or `meshmonitor` (container name)
   - **Forward Port**: `3001` (container port, not host port)
   - **Websockets Support**: Enable
   - **SSL**: Request SSL certificate and enable Force SSL

3. **Update MeshMonitor Configuration**:
   - Same as Swag method above

### Custom Base URL (Subfolder Deployment)

To deploy MeshMonitor in a subfolder (e.g., `http://unraid/meshmonitor`):

1. **Edit Container**:
   - Add **Base URL** variable: `/meshmonitor`

2. **Configure Reverse Proxy**:
   ```nginx
   location /meshmonitor/ {
       proxy_pass http://[UNRAID-IP]:8080/;
       # ... other proxy settings
   }
   ```

### OIDC/SSO Integration

For enterprise authentication, you can configure OIDC:

1. **Edit Container**:
   - Add variables:
     - `OIDC_ISSUER`: Your identity provider URL
     - `OIDC_CLIENT_ID`: Your client ID
     - `OIDC_CLIENT_SECRET`: Your client secret
     - `OIDC_REDIRECT_URI`: `https://yourdomain.com/api/auth/oidc/callback`

2. **Configure Identity Provider**:
   - Add redirect URI to your IdP configuration
   - Ensure proper scopes are granted

### Web Push Notifications

To enable browser push notifications:

1. **Generate VAPID Keys**:
   ```bash
   # From a system with Node.js installed:
   npx web-push generate-vapid-keys
   ```

2. **Add to Container**:
   - `VAPID_PUBLIC_KEY`: Your public key
   - `VAPID_PRIVATE_KEY`: Your private key
   - `VAPID_SUBJECT`: `mailto:your-email@example.com`

## Troubleshooting

### Permission Errors (EACCES / Cannot Write to /data)

**This is the most common issue on first install.**

The MeshMonitor container runs as UID 1000 (user `node`). If your appdata directory has different ownership, you'll see permission errors in the logs.

**Symptoms:**
- Container fails to start or crashes immediately
- Logs show: `EACCES: permission denied` or `cannot write to /data`
- Health check shows unhealthy

**Fix (Choose ONE method):**

**Method 1: Quick Fix (From Container)**
```bash
# Stop the container first if it's running
docker exec meshmonitor chown -R node:node /data
```

**Method 2: Fix from unRAID Terminal (Recommended)**
```bash
# From unRAID terminal or SSH:
chown -R 1000:1000 /mnt/user/appdata/meshmonitor
chmod -R 755 /mnt/user/appdata/meshmonitor
```

**Method 3: Fix from unRAID UI**
1. Go to **Docker** tab → Stop MeshMonitor
2. Open unRAID terminal (top right)
3. Run:
   ```bash
   chown -R 1000:1000 /mnt/user/appdata/meshmonitor
   ```
4. Start MeshMonitor container

After fixing permissions, restart the container and check the logs. You should see it start successfully.

### Container Won't Start

1. **Check Logs**:
   - Go to **Docker** tab
   - Click MeshMonitor icon → **Logs**
   - Look for error messages

2. **Common Issues**:
   - **Permission errors**: See "Permission Errors" section above (most common)
   - **Port conflict**: Change WebUI port to unused port
   - **Meshtastic node unreachable**: Verify node IP and network connectivity

### Can't Connect to Meshtastic Node

1. **Verify Node IP**:
   - Ping your Meshtastic node from unRAID:
     ```bash
     ping [MESHTASTIC-NODE-IP]
     ```

2. **Check Meshtastic HTTP API**:
   - Access: `http://[MESHTASTIC-NODE-IP]/api/v1/nodes`
   - Should return JSON data

3. **Verify Port**:
   - Default TCP port is 4403
   - Check if custom port is configured on your node

4. **Check Network**:
   - Ensure Meshtastic node is on same network as unRAID
   - Check firewall rules

### Web Interface Not Loading

1. **Check Container Status**:
   - Ensure container is running (green dot)
   - Check health status (should be "healthy")

2. **Verify Port Access**:
   - Try accessing: `http://[UNRAID-IP]:[PORT]/api/health`
   - Should return: `{"status":"healthy"}`

3. **CORS Errors / Blank Page**:
   - If you see CORS errors in browser console (F12), you may need to set **Allowed Origins**
   - Set it to your exact access URL (e.g., `http://192.168.1.50:8080`)
   - For most users, leaving it EMPTY works fine (uses default localhost)

### Database Issues

1. **Corrupted Database**:
   - Stop the container
   - Backup existing database:
     ```bash
     cp /mnt/user/appdata/meshmonitor/meshmonitor.db /mnt/user/appdata/meshmonitor/meshmonitor.db.backup
     ```
   - Start container (will create new database)

2. **Restore from Backup**:
   - Go to **Settings** → **Backup & Restore**
   - Select a backup to restore
   - Or set `RESTORE_FROM_BACKUP` environment variable to backup directory name

## Backup and Restore

### Automatic Backups

MeshMonitor creates automatic system backups in `/data/system-backups/`:

1. **View Backups**:
   - Access: `/mnt/user/appdata/meshmonitor/system-backups/`
   - Backups are timestamped (e.g., `2025-11-08_151637`)

2. **Backup Contents**:
   - SQLite database
   - Configuration files
   - Apprise configuration

### Manual Backup

1. **Stop the Container**:
   - Go to **Docker** tab
   - Click MeshMonitor icon → **Stop**

2. **Backup Data Directory**:
   ```bash
   # From unRAID terminal:
   tar -czf /mnt/user/backups/meshmonitor-backup-$(date +%Y%m%d).tar.gz \
       /mnt/user/appdata/meshmonitor
   ```

3. **Restart Container**:
   - Click MeshMonitor icon → **Start**

### Restore from Backup

#### Method 1: System Backup Restore

1. **Edit Container**:
   - Add environment variable:
     - **Name**: `RESTORE_FROM_BACKUP`
     - **Value**: Backup directory name (e.g., `2025-11-08_151637`)

2. **Apply and Start**:
   - Container will restore from specified backup
   - Remove variable after successful restore

#### Method 2: Manual Restore

1. **Stop Container**:
   - Go to **Docker** tab → Stop MeshMonitor

2. **Restore Data**:
   ```bash
   # From unRAID terminal:
   cd /mnt/user/appdata
   rm -rf meshmonitor
   tar -xzf /mnt/user/backups/meshmonitor-backup-YYYYMMDD.tar.gz
   ```

3. **Fix Permissions**:
   ```bash
   chown -R 1000:1000 /mnt/user/appdata/meshmonitor
   ```

4. **Start Container**:
   - Go to **Docker** tab → Start MeshMonitor

### unRAID Appdata Backup

MeshMonitor data is automatically included in unRAID Appdata backups if you use:
- **CA Appdata Backup/Restore** plugin
- **Crashplan**, **Duplicati**, or similar backup solutions pointed at `/mnt/user/appdata`

## Performance Optimization

### Resource Limits

To prevent MeshMonitor from using excessive resources:

1. **Edit Container**:
   - Scroll to **Advanced View** (top right toggle)
   - Set **CPU Pinning** (optional)
   - Set **Memory Limit** (recommended: 512MB-1GB)

### Database Optimization

For large deployments with extensive message history:

1. **Message Retention**:
   - Go to **Settings** → **Database**
   - Configure message retention policies
   - Purge old messages regularly

2. **Database Maintenance**:
   - MeshMonitor automatically maintains the database
   - Vacuum operations run periodically

## Updating MeshMonitor

See [Auto-Upgrade Setup](#auto-upgrade-setup) section above.

## Support and Community

- **GitHub Issues**: https://github.com/Yeraze/meshmonitor/issues
- **Documentation**: https://github.com/Yeraze/meshmonitor/tree/main/docs
- **Meshtastic Community**: https://meshtastic.org/

## Security Considerations

1. **Session Secret**:
   - Always use a strong, randomly generated session secret
   - Never reuse secrets across deployments

2. **Network Access**:
   - MeshMonitor should only be accessible from trusted networks
   - Use HTTPS for external access
   - Consider using VPN for remote access

3. **Docker Socket**:
   - Only mount Docker socket if you need in-app auto-upgrade
   - Understand the security implications

4. **Reverse Proxy**:
   - Use reverse proxy with SSL/TLS for production
   - Keep proxy software updated

5. **Authentication**:
   - Enable authentication for production deployments
   - Use strong passwords
   - Consider OIDC/SSO for enterprise environments

## License

MeshMonitor is open source software. Check the repository for license details.

---

**Last Updated**: 2025-11-11
**Template Version**: 2.16.8
