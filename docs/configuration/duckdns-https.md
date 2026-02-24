# Setting Up HTTPS with DuckDNS

This guide will walk you through setting up free HTTPS for MeshMonitor using DuckDNS and Caddy, even if you have no experience with reverse proxies or SSL certificates.

## Why HTTPS?

HTTPS is required for certain MeshMonitor features:
- **Push Notifications** - Web browsers only allow push notifications over HTTPS or localhost
- **PWA Installation** - Installing MeshMonitor as a Progressive Web App requires HTTPS
- **Security** - Encrypts communication between your browser and the server

## What You'll Need

- A MeshMonitor instance running on your local network
- About 15 minutes
- No prior experience with reverse proxies or SSL required!

## Overview

We'll use three free services/tools:
1. **DuckDNS** - Free dynamic DNS service that gives you a domain name (e.g., `mymesh.duckdns.org`)
2. **Caddy** - Automatic HTTPS reverse proxy (handles SSL certificates automatically)
3. **Let's Encrypt** - Free SSL certificates (Caddy handles this automatically)

## Step 1: Get a DuckDNS Domain

1. Visit [DuckDNS.org](https://www.duckdns.org/)
2. Sign in with your preferred account (Google, GitHub, etc.)
3. Create a new subdomain (e.g., `mymesh`)
   - You'll get a domain like `mymesh.duckdns.org`
4. Point it to your **public IP address**
   - DuckDNS will show your current IP - just click "update ip"
5. **Save your token** - you'll need it for automatic IP updates

### Finding Your Public IP

Your public IP is visible on the DuckDNS homepage after logging in. If you have a dynamic IP (changes occasionally), you'll need to update DuckDNS when it changes. See the [DuckDNS installation page](https://www.duckdns.org/install.jsp) for automatic update scripts.

## Step 2: Port Forwarding

You need to forward ports 80 and 443 from your router to the machine running MeshMonitor.

### On Your Router:

1. Access your router's admin panel (usually `192.168.1.1` or `192.168.0.1`)
2. Find "Port Forwarding" or "Virtual Server" settings
3. Create two port forwarding rules:

| Service | External Port | Internal IP | Internal Port | Protocol |
|---------|--------------|-------------|---------------|----------|
| HTTP    | 80           | 192.168.x.x | 80           | TCP      |
| HTTPS   | 443          | 192.168.x.x | 443          | TCP      |

Replace `192.168.x.x` with the local IP of your MeshMonitor server.

**Finding your local IP:**
```bash
# Linux/Mac
hostname -I

# Or check your router's DHCP client list
```

## Step 3: Install Caddy

Caddy is a web server that automatically obtains and renews SSL certificates from Let's Encrypt.

### Option A: Docker (Recommended)

Create a `docker-compose.caddy.yml` file alongside your MeshMonitor setup:

```yaml
version: '3.8'

services:
  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"      # HTTP (for Let's Encrypt verification)
      - "443:443"    # HTTPS
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - meshmonitor_default

volumes:
  caddy_data:
  caddy_config:

networks:
  meshmonitor_default:
    external: true
```

### Option B: Native Installation

**Ubuntu/Debian:**
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**Other systems:** See [Caddy installation docs](https://caddyserver.com/docs/install)

## Step 4: Configure Caddy

Create a `Caddyfile` with the following content:

```
# Replace mymesh.duckdns.org with your actual DuckDNS domain
mymesh.duckdns.org {
    # Reverse proxy to MeshMonitor
    reverse_proxy localhost:8080

    # Enable compression
    encode gzip

    # Logging (optional)
    log {
        output file /var/log/caddy/meshmonitor.log
    }
}
```

**Important:** Replace `mymesh.duckdns.org` with your DuckDNS domain and `localhost:8080` with your MeshMonitor address.

### If MeshMonitor is Running in Docker:

If MeshMonitor is in a Docker container, use the container name instead of localhost:

```
mymesh.duckdns.org {
    reverse_proxy meshmonitor:8080
}
```

## Step 5: Start Caddy

### Docker:
```bash
docker compose -f docker-compose.caddy.yml up -d
```

### Native Installation:
```bash
# Place Caddyfile in /etc/caddy/Caddyfile
sudo systemctl start caddy
sudo systemctl enable caddy  # Start on boot
```

## Step 6: Test Your Setup

1. Wait 1-2 minutes for Caddy to obtain the SSL certificate
2. Visit `https://mymesh.duckdns.org` (use your domain)
3. You should see MeshMonitor with a valid SSL certificate!

### Troubleshooting

**"Connection refused" or "Can't reach site"**
- Verify port forwarding is set up correctly
- Check that ports 80 and 443 are open on your router
- Ensure your firewall allows ports 80 and 443

**"Your connection is not private" SSL error**
- Wait a few minutes for Caddy to obtain the certificate
- Check Caddy logs: `docker logs caddy` or `sudo journalctl -u caddy`
- Verify your DuckDNS domain points to your public IP

**"502 Bad Gateway"**
- Verify MeshMonitor is running: `docker ps` or check the service status
- Check the reverse_proxy address in Caddyfile matches your MeshMonitor address

**Check Caddy logs:**
```bash
# Docker
docker logs caddy

# Native
sudo journalctl -u caddy -f
```

## Complete Docker Example

If you want everything in one file, here's a complete setup:

```yaml
version: '3.8'

services:
  meshmonitor:
    image: yeraze/meshmonitor:latest
    container_name: meshmonitor
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - meshmonitor_data:/data
    environment:
      - PORT=8080

  caddy:
    image: caddy:latest
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  meshmonitor_data:
  caddy_data:
  caddy_config:
```

**Caddyfile:**
```
mymesh.duckdns.org {
    reverse_proxy meshmonitor:8080
    encode gzip
}
```

Start everything:
```bash
docker compose up -d
```

## Keeping DuckDNS Updated

If your home IP changes, you need to update DuckDNS. You can automate this:

### Cron Job (Linux)
```bash
# Edit crontab
crontab -e

# Add this line (replace YOUR_TOKEN and YOUR_DOMAIN)
*/5 * * * * curl "https://www.duckdns.org/update?domains=YOUR_DOMAIN&token=YOUR_TOKEN&ip="
```

### Docker Container
```yaml
  duckdns:
    image: lscr.io/linuxserver/duckdns:latest
    container_name: duckdns
    environment:
      - SUBDOMAINS=YOUR_DOMAIN
      - TOKEN=YOUR_TOKEN
      - TZ=America/New_York
    restart: unless-stopped
```

## Security Notes

- Caddy automatically renews SSL certificates (every 60 days)
- All traffic between your browser and MeshMonitor is encrypted
- Consider setting up MeshMonitor authentication if exposing to the internet
- Consider using a firewall to limit access to specific IPs if possible

## Next Steps

Now that you have HTTPS set up:
- Enable [Push Notifications](../features/notifications.md)
- Install MeshMonitor as a PWA on your phone
- Set up [authentication](./sso.md) for added security

## Additional Resources

- [DuckDNS Documentation](https://www.duckdns.org/spec.jsp)
- [Caddy Documentation](https://caddyserver.com/docs/)
- [MeshMonitor Reverse Proxy Guide](./reverse-proxy.md) - Advanced configurations
