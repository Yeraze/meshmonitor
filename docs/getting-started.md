# Getting Started

This guide will help you get MeshMonitor up and running quickly.

## Prerequisites

Before you begin, ensure you have:

- A Meshtastic device connected to your network via IP (WiFi or Ethernet)
- **OR** A Serial/USB device with the [Serial Bridge](/configuration/serial-bridge)
- **OR** A Bluetooth device with the [BLE Bridge](/configuration/ble-bridge)
- **OR** `meshtasticd` running as a virtual node
- Docker and Docker Compose installed (for Docker deployment)
- **OR** Node.js 20+ and npm (for bare metal deployment)

## Quick Start with Docker Compose

The fastest way to get started is using Docker Compose. This takes **less than 60 seconds**!

### 1. Create docker-compose.yml

Create a `docker-compose.yml` file with the following content:

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
      - ALLOWED_ORIGINS=http://localhost:8080  # Required for CORS

volumes:
  meshmonitor-data:
    driver: local
```

**That's it!** No need for SESSION_SECRET, COOKIE_SECURE, or other complex settings for basic usage.

### 2. Start MeshMonitor

```bash
docker compose up -d
```

### 3. Access the Interface

Open your browser and navigate to:

```
http://localhost:8080
```

### 4. Login with Default Credentials

On first launch, MeshMonitor creates a default admin account:

- **Username**: `admin`
- **Password**: `changeme`

**Important**: After logging in, immediately:

1. Click on your username in the top right
2. Select "Change Password"
3. Set a strong, unique password

## What Just Happened?

MeshMonitor's **Quick Start** is optimized for **simple local/home use**:
- ✅ Works over HTTP (no HTTPS required)
- ✅ No SESSION_SECRET needed (auto-generated with warning)
- ✅ Secure cookies automatically disabled for HTTP
- ✅ CSRF protection active
- ✅ Rate limiting active (1000 requests/15min)
- ✅ Perfect for personal/home deployments

This configuration is ideal for:
- Personal/home network deployments
- Behind a firewall on trusted networks
- Local-only access (not exposed to the internet)
- Quick testing and evaluation

**Note**: The Docker container runs in production mode but with sensible defaults for local use. For internet-facing deployments, see the [Production Deployment Guide](/configuration/production).

## Optional Configuration

### Different Node IP

If your Meshtastic node is at a different IP:

```bash
export MESHTASTIC_NODE_IP=192.168.5.25
docker compose up -d
```

### Custom Timezone

```yaml
environment:
  - MESHTASTIC_NODE_IP=192.168.1.100
  - TZ=Europe/London  # See: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
```

### Accessing from Different Devices/IPs

**Important:** MeshMonitor uses CORS protection to prevent unauthorized access. You **must** set `ALLOWED_ORIGINS` to match how you're accessing the application.

**For localhost access** (as shown in the basic example):
```yaml
- ALLOWED_ORIGINS=http://localhost:8080
```

**For access via server IP** (e.g., `http://192.168.1.50:8080`):
```yaml
environment:
  - MESHTASTIC_NODE_IP=192.168.1.100
  - ALLOWED_ORIGINS=http://192.168.1.50:8080  # Replace with your server's IP
```

**For multiple access methods** (localhost AND server IP):
```yaml
- ALLOWED_ORIGINS=http://localhost:8080,http://192.168.1.50:8080
```

**Additional examples:**
```yaml
# Multiple origins with hostname
- ALLOWED_ORIGINS=http://192.168.1.50:8080,http://meshmonitor.local:8080

# Allow all origins (not recommended, use for testing only)
- ALLOWED_ORIGINS=*
```

## Production Deployment

For production deployments with HTTPS, reverse proxies, or public internet access, see:

- **[Production Deployment Guide](/configuration/production)** - Full production setup with HTTPS
- **[Reverse Proxy Configuration](/configuration/reverse-proxy)** - nginx, Caddy, Traefik examples
- **[SSO Setup](/configuration/sso)** - Enterprise authentication with OIDC

### ⚠️ Critical: Required Environment Variables for HTTPS

When deploying with HTTPS and a reverse proxy, you **MUST** set:

```bash
SESSION_SECRET=your-secure-random-string       # REQUIRED
TRUST_PROXY=true                                # REQUIRED
COOKIE_SECURE=true                              # REQUIRED
ALLOWED_ORIGINS=https://meshmonitor.example.com # REQUIRED!
```

**Without `ALLOWED_ORIGINS`, you will get blank pages and CORS errors!**

### Key Differences in Production

- **`SESSION_SECRET`**: Required, must be set to a secure random string
- **HTTPS**: Strongly recommended for production
- **`TRUST_PROXY=true`**: Required when behind reverse proxy (nginx, Traefik, Caddy)
- **`COOKIE_SECURE=true`**: Required for HTTPS
- **`ALLOWED_ORIGINS`**: **CRITICAL** - Must match your HTTPS domain, or frontend won't load
- **Rate limiting**: Stricter (1000 requests/15min vs 10,000)

## Using with Virtual or Physical Devices

### Virtual Nodes with meshtasticd

If you're using `meshtasticd` (the virtual Meshtastic node daemon) for testing without physical hardware:

```bash
# Start meshtasticd (example)
meshtasticd --hwmodel BETAFPV_2400_TX

# Then set the IP to localhost
export MESHTASTIC_NODE_IP=localhost
docker compose up -d
```

See the [meshtasticd configuration guide](/configuration/meshtasticd) for more details.

### Serial/USB Devices

For Serial or USB-connected Meshtastic devices, use the [Meshtastic Serial Bridge](/configuration/serial-bridge) to expose your device on TCP port 4403.

### Bluetooth Devices

For Bluetooth Low Energy (BLE) Meshtastic devices, use the [MeshMonitor BLE Bridge](/configuration/ble-bridge) to create a TCP-to-BLE gateway.

## Next Steps

Now that you have MeshMonitor running:

- **[FAQ](/faq)** - Common issues and solutions
- **[Features Guide](/features/settings)** - Explore all available features
- **[Automation](/features/automation)** - Set up auto-acknowledge and auto-announce
- **[Device Configuration](/features/device)** - Configure your Meshtastic node from the UI
- **[Production Deployment](/configuration/production)** - Deploy securely for public access
- **[Development Setup](/development/setup)** - Set up a local development environment

## Troubleshooting

For common issues and solutions, see the **[FAQ](/faq)** which covers:

- 🚨 **Blank white screen** - CORS and ALLOWED_ORIGINS issues
- 🔐 **Can't login / Session logs out** - Cookie security and TRUST_PROXY configuration
- 📡 **Cannot connect to node** - Network connectivity troubleshooting
- 🔄 **Multiple nodes** - How to run multiple MeshMonitor instances
- 💾 **Database issues** - How to reset and back up your data
- 👤 **Password reset** - Admin and user password management

### Quick Fixes

**Cannot connect to node:**
```bash
# Verify node is reachable
ping 192.168.1.100

# Check port 4403 is accessible
telnet 192.168.1.100 4403
```

**Database errors:**
```bash
docker compose down
docker volume rm meshmonitor-meshmonitor-data
docker compose up -d
```

**Docker permission errors:**
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

## Getting Help

If you run into issues:

- **[FAQ](/faq)** - Common issues and solutions
- **[Configuration Documentation](/configuration/)** - Advanced configuration
- **[Development Documentation](/development/)** - Developer resources
- **[GitHub Issues](https://github.com/yeraze/meshmonitor/issues)** - Search existing issues or open a new one
