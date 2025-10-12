# Getting Started

This guide will help you get MeshMonitor up and running quickly.

## Prerequisites

Before you begin, ensure you have:

- A Meshtastic device connected to your network via IP (WiFi or Ethernet)
- **OR** `meshtasticd` running as a virtual node
- Docker and Docker Compose installed (for Docker deployment)
- **OR** Node.js 18+ and npm (for bare metal deployment)

## Quick Start with Docker Compose

The fastest way to get started is using Docker Compose:

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
      - NODE_ENV=production
      - TZ=America/New_York
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
      - SESSION_SECRET=change-this-to-a-random-string
      - COOKIE_SECURE=false  # Required for HTTP (non-HTTPS) deployments

volumes:
  meshmonitor-data:
    driver: local
```

**Important**: Generate a secure `SESSION_SECRET`:

```bash
openssl rand -base64 32
```

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

## Development Setup

For development or if you prefer running MeshMonitor without Docker:

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Environment Variables

```bash
export MESHTASTIC_NODE_IP=192.168.1.100
```

### 3. Start the Development Server

MeshMonitor has two components that need to run:

```bash
# Terminal 1: Start the frontend
npm run dev

# Terminal 2: Start the backend
npm run dev:server
```

Or run both together:

```bash
npm run dev:full
```

### 4. Access the Development Server

Open your browser to:

```
http://localhost:5173
```

The backend API will be available on:

```
http://localhost:3000
```

## Using with meshtasticd

If you're using `meshtasticd` (the virtual Meshtastic node daemon), make sure it's running and accessible before starting MeshMonitor:

```bash
# Start meshtasticd (example)
meshtasticd --hwmodel BETAFPV_2400_TX

# Then set the IP to localhost
export MESHTASTIC_NODE_IP=localhost
```

See the [meshtasticd configuration guide](/configuration/meshtasticd) for more details.

## Next Steps

Now that you have MeshMonitor running:

- **[Configuration Guide](/configuration/)** - Learn about configuring MeshMonitor for production
- **[Using meshtasticd](/configuration/meshtasticd)** - Set up virtual Meshtastic nodes
- **[SSO Setup](/configuration/sso)** - Configure Single Sign-On for enterprise use
- **[Reverse Proxy](/configuration/reverse-proxy)** - Set up NGINX or other reverse proxies
- **[Production Deployment](/configuration/production)** - Deploy MeshMonitor in production

## Troubleshooting

### Cannot Connect to Node

If MeshMonitor cannot connect to your Meshtastic node:

1. Verify the node IP address is correct
2. Ensure the node is reachable from your network:
   ```bash
   ping 192.168.1.100
   ```
3. Check that the node has IP connectivity enabled (via Meshtastic app or CLI)
4. Verify firewall rules allow connections on the required ports

### Database Issues

If you encounter database errors:

1. Stop MeshMonitor: `docker compose down`
2. Remove the database volume: `docker volume rm meshmonitor_data`
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
