# Configuration Overview

MeshMonitor is designed to be flexible and adaptable to various deployment scenarios. This section covers all configuration options and deployment strategies.

## Configuration Topics

### [BLE Bridge for Bluetooth Devices](/configuration/ble-bridge)
Connect MeshMonitor to Bluetooth Low Energy (BLE) Meshtastic devices using the BLE Bridge. Perfect for portable devices and systems with Bluetooth support.

### [Using meshtasticd](/configuration/meshtasticd)
Learn how to configure MeshMonitor to work with `meshtasticd`, the virtual Meshtastic node daemon, perfect for testing and development without physical hardware, or for Serial/USB-connected devices.

### [SSO Setup](/configuration/sso)
Configure Single Sign-On (SSO) authentication using OpenID Connect (OIDC) for enterprise deployments and centralized identity management.

### [Reverse Proxy](/configuration/reverse-proxy)
Set up NGINX, Apache, or other reverse proxies to handle SSL termination, load balancing, and secure external access to MeshMonitor.

### [HTTP vs HTTPS](/configuration/http-vs-https)
Understand the differences between HTTP and HTTPS deployments, security considerations, and how to configure SSL/TLS certificates.

### [Production Deployment](/configuration/production)
Best practices and recommendations for deploying MeshMonitor in production environments, including high availability and monitoring.

### [Fail2ban Integration](/configuration/fail2ban)
Protect your instance from brute-force attacks using fail2ban. Includes setup guide, AbuseIPDB integration, and advanced configuration options.

### [Push Notifications](/features/notifications)
Configure push notifications for iOS, Android, and desktop browsers. Learn about HTTPS requirements, VAPID keys, and step-by-step setup guides for all platforms.

## Environment Variables

MeshMonitor can be configured using environment variables. Here are the most important ones:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MESHTASTIC_NODE_IP` | IP address of your Meshtastic node | `192.168.1.100` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Backend server port | `3001` |
| `SESSION_SECRET` | Secret key for session encryption (REQUIRED in production) | Auto-generated |
| `NODE_ENV` | Environment mode (`development` or `production`) | `development` |
| `DATABASE_PATH` | SQLite database file path | `/data/meshmonitor.db` |
| `BASE_URL` | Base path if serving from subfolder (e.g., `/meshmonitor`) | `/` (root) |

### Security & Reverse Proxy Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRUST_PROXY` | Trust reverse proxy headers (required for HTTPS behind proxy) | `1` in production |
| `COOKIE_SECURE` | Require HTTPS for cookies | `true` in production |
| `COOKIE_SAMESITE` | Cookie SameSite policy (`strict`, `lax`, or `none`) | `strict` in production |
| `SESSION_MAX_AGE` | Session cookie lifetime in milliseconds | `86400000` (24 hours) |
| `ALLOWED_ORIGINS` | **REQUIRED for HTTPS/reverse proxy**: Comma-separated list of allowed CORS origins | localhost URLs in development |

### Authentication Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISABLE_ANONYMOUS` | Disable anonymous access - require login for all features | `false` |
| `DISABLE_LOCAL_AUTH` | Disable local username/password authentication (OIDC only) | `false` |
| `ADMIN_USERNAME` | Override default admin username on first run | `admin` |

### Rate Limiting Variables

| Variable | Description | Default (Production) | Default (Development) |
|----------|-------------|----------------------|-----------------------|
| `RATE_LIMIT_API` | Max API requests per 15 minutes | `1000` (~1 req/sec) | `10000` |
| `RATE_LIMIT_AUTH` | Max auth attempts per 15 minutes | `5` | `100` |
| `RATE_LIMIT_MESSAGES` | Max messages per minute | `30` | `100` |

**Note**: Rate limit violations are logged with IP address and path for troubleshooting. Adjust these values based on your usage patterns.

### Access Logging Variables (for fail2ban)

| Variable | Description | Default |
|----------|-------------|---------|
| `ACCESS_LOG_ENABLED` | Enable Apache-style access logging for fail2ban integration | `false` |
| `ACCESS_LOG_PATH` | Path to access log file | `/data/logs/access.log` |
| `ACCESS_LOG_FORMAT` | Log format (`combined`, `common`, or `tiny`) | `combined` |

**Note**: Requires bind mount for host access. See [Fail2ban Integration](/configuration/fail2ban) for complete setup guide.

### SSO Variables (OIDC)

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER` | OIDC issuer URL |
| `OIDC_CLIENT_ID` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_REDIRECT_URI` | Callback URL for OIDC |

See the [SSO Setup guide](/configuration/sso) for detailed OIDC configuration.

## Configuration Files

### Docker Compose

For Docker deployments, configuration is typically done through environment variables in `docker-compose.yml`:

```yaml
services:
  meshmonitor:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - PORT=3000
      - SESSION_SECRET=your-secret-key-here
    ports:
      - "8080:8080"
    volumes:
      - meshmonitor_data:/app/data
```

### Kubernetes (Helm)

For Kubernetes deployments, use the Helm chart values file:

```yaml
# values.yaml
meshmonitor:
  nodeIp: "192.168.1.100"
  port: 3000

ingress:
  enabled: true
  host: meshmonitor.example.com
  tls:
    enabled: true
```

See the [Production Deployment guide](/configuration/production) for complete Helm configuration.

## Database Configuration

MeshMonitor uses SQLite for data storage by default. The database file is stored in the `data/` directory.

### Database Location

- **Docker**: `/app/data/meshmonitor.db` (mounted as a volume)
- **Bare Metal**: `./data/meshmonitor.db` (relative to project root)

### Backup and Migration

To backup your database:

```bash
# Docker
docker cp meshmonitor:/app/data/meshmonitor.db ./backup.db

# Bare Metal
cp data/meshmonitor.db backup.db
```

## Security Considerations

### Session Secret

Always set a strong `SESSION_SECRET` in production:

```bash
# Generate a secure random string
openssl rand -base64 32
```

### Database Encryption

The database stores password hashes using bcrypt. User passwords are never stored in plain text.

### HTTPS

Always use HTTPS in production environments. See the [HTTP vs HTTPS guide](/configuration/http-vs-https) for setup instructions.

## Logging

MeshMonitor logs to stdout/stderr by default. Configure log aggregation in your deployment platform:

- **Docker**: Use `docker logs` or configure a logging driver
- **Kubernetes**: Logs are available via `kubectl logs`
- **Bare Metal**: Redirect output to log files or use a process manager like systemd

## Next Steps

- [Connect to Bluetooth devices](/configuration/ble-bridge)
- [Configure meshtasticd](/configuration/meshtasticd)
- [Set up SSO](/configuration/sso)
- [Configure a reverse proxy](/configuration/reverse-proxy)
- [Deploy to production](/configuration/production)
