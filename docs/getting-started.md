# Getting Started

This guide will help you get MeshMonitor up and running quickly.

## Prerequisites

Before you begin, ensure you have:

- A Meshtastic device connected to your network via IP (WiFi or Ethernet)
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

### Remote Access Over Local Network

**Important:** If you want to access MeshMonitor from other devices on your local network (e.g., `http://192.168.1.50:8080`), you **must** set `ALLOWED_ORIGINS`:

```yaml
environment:
  - MESHTASTIC_NODE_IP=192.168.1.100
  - ALLOWED_ORIGINS=http://192.168.1.50:8080  # Replace with your server's IP
```

**Why?** MeshMonitor uses CORS protection to prevent unauthorized access. By default, only `http://localhost:8080` is allowed. When accessing from another device, you need to explicitly allow your server's IP address.

**Examples:**
```yaml
# Single origin
- ALLOWED_ORIGINS=http://192.168.1.50:8080

# Multiple origins (comma-separated)
- ALLOWED_ORIGINS=http://192.168.1.50:8080,http://meshmonitor.local:8080

# Allow all origins (not recommended, use for testing only)
- ALLOWED_ORIGINS=*
```

**Note:** `ALLOWED_ORIGINS` is not required for `http://localhost` access - that works by default.

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

## Development Setup

For development or if you prefer running MeshMonitor without Docker:

### 1. Install Dependencies

```bash
git clone --recurse-submodules https://github.com/yeraze/meshmonitor.git
cd meshmonitor
npm install
```

### 2. Set Environment Variables

```bash
export MESHTASTIC_NODE_IP=192.168.1.100
```

### 3. Start the Development Server

MeshMonitor has two components that need to run:

```bash
# Option 1: Run both together (recommended)
npm run dev:full

# Option 2: Run separately in two terminals
npm run dev        # Terminal 1: Frontend
npm run dev:server # Terminal 2: Backend
```

### 4. Access the Development Server

Open your browser to:

```
http://localhost:5173  # Frontend (Vite dev server)
```

The backend API runs on:

```
http://localhost:3001  # Backend (Express)
```

## Using with meshtasticd

If you're using `meshtasticd` (the virtual Meshtastic node daemon), make sure it's running and accessible before starting MeshMonitor:

```bash
# Start meshtasticd (example)
meshtasticd --hwmodel BETAFPV_2400_TX

# Then set the IP to localhost
export MESHTASTIC_NODE_IP=localhost
docker compose up -d
```

See the [meshtasticd configuration guide](/configuration/meshtasticd) for more details.

## Next Steps

Now that you have MeshMonitor running:

- **[Features Guide](/features/settings)** - Explore all available features
- **[Automation](/features/automation)** - Set up auto-acknowledge and auto-announce
- **[Device Configuration](/features/device)** - Configure your Meshtastic node from the UI
- **[Production Deployment](/configuration/production)** - Deploy securely for public access

## Troubleshooting

### Cannot Connect to Node

If MeshMonitor cannot connect to your Meshtastic node:

1. Verify the node IP address is correct
2. Ensure the node is reachable from your network:
   ```bash
   ping 192.168.1.100
   ```
3. Check that the node has IP connectivity enabled (via Meshtastic app or CLI)
4. Verify firewall rules allow connections on port 4403

### Login Issues

If you can login but get immediately logged out:

**This shouldn't happen in development mode**, but if it does:
- Check browser console for errors
- Verify you haven't set `NODE_ENV=production` (development is the default)
- Try clearing browser cookies for localhost:8080

### Database Issues

If you encounter database errors:

1. Stop MeshMonitor: `docker compose down`
2. Remove the database volume: `docker volume rm meshmonitor-meshmonitor-data`
3. Restart: `docker compose up -d`

**Note**: This will delete all stored data. Export any important data first.

### Docker Permission Issues

If you see permission errors with Docker:

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and back in for changes to take effect
```

## Getting Help

If you run into issues:

- Check the [Configuration Documentation](/configuration/)
- Review the [Development Documentation](/development/)
- Search existing [GitHub Issues](https://github.com/yeraze/meshmonitor/issues)
- Open a new issue with details about your setup and the problem
