# Reverse Proxy Configuration

A reverse proxy sits in front of MeshMonitor to handle SSL/TLS termination, load balancing, caching, and provide additional security. This guide covers popular reverse proxy solutions.

## Why Use a Reverse Proxy?

Benefits of using a reverse proxy:

- **SSL/TLS Termination**: Handle HTTPS encryption at the proxy level
- **Security**: Hide internal network topology, add security headers
- **Load Balancing**: Distribute traffic across multiple instances
- **Caching**: Cache static assets for better performance
- **Centralized Logging**: Single point for access logs
- **Multiple Services**: Host multiple applications on one server/domain

## ⚠️ Critical: Required Environment Variables

When deploying MeshMonitor behind a reverse proxy with HTTPS, you **MUST** set these environment variables:

```bash
TRUST_PROXY=true                                    # Trust proxy headers
COOKIE_SECURE=true                                  # Enable secure cookies for HTTPS
ALLOWED_ORIGINS=https://meshmonitor.example.com    # Allow CORS from your domain
```

**Without `ALLOWED_ORIGINS`, you will get:**
- Blank white pages
- 500 errors on JavaScript files
- CORS errors in browser console: "Access to fetch at '...' has been blocked by CORS policy"

This happens because when using HTTPS, the browser considers the frontend and backend as different origins and blocks API requests for security. Setting `ALLOWED_ORIGINS` tells MeshMonitor to allow requests from your HTTPS domain.

## NGINX

NGINX is a popular, high-performance reverse proxy and web server.

### Basic Configuration

Create `/etc/nginx/sites-available/meshmonitor`:

```nginx
server {
    listen 80;
    server_name meshmonitor.example.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name meshmonitor.example.com;

    # SSL Configuration
    ssl_certificate /etc/ssl/certs/meshmonitor.example.com.crt;
    ssl_certificate_key /etc/ssl/private/meshmonitor.example.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy Configuration
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts for long-running requests
        proxy_read_timeout 90s;
        proxy_connect_timeout 90s;
        proxy_send_timeout 90s;
    }

    # Logging
    access_log /var/log/nginx/meshmonitor-access.log;
    error_log /var/log/nginx/meshmonitor-error.log;
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/meshmonitor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### With Let's Encrypt SSL

Use Certbot for free SSL certificates:

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d meshmonitor.example.com

# Auto-renewal is configured automatically
```

### Docker Compose with NGINX

Run NGINX alongside MeshMonitor:

```yaml
version: '3.8'

services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - SESSION_SECRET=your-secure-random-string
      - TRUST_PROXY=true  # Required when behind a reverse proxy
      - COOKIE_SECURE=true  # Enable secure cookies for HTTPS
      - ALLOWED_ORIGINS=https://meshmonitor.example.com  # REQUIRED for HTTPS!
    volumes:
      - meshmonitor-data:/data
    expose:
      - "8080"
    networks:
      - app-network

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/ssl:ro
    depends_on:
      - meshmonitor
    networks:
      - app-network

volumes:
  meshmonitor-data:

networks:
  app-network:
    driver: bridge
```

## Apache

Apache HTTP Server with mod_proxy.

### Configuration

Create `/etc/apache2/sites-available/meshmonitor.conf`:

```apache
<VirtualHost *:80>
    ServerName meshmonitor.example.com
    Redirect permanent / https://meshmonitor.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName meshmonitor.example.com

    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/ssl/certs/meshmonitor.example.com.crt
    SSLCertificateKeyFile /etc/ssl/private/meshmonitor.example.com.key
    SSLCertificateChainFile /etc/ssl/certs/ca-bundle.crt

    # Security Headers
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-XSS-Protection "1; mode=block"

    # Proxy Configuration
    ProxyPreserveHost On
    ProxyPass / http://localhost:8080/
    ProxyPassReverse / http://localhost:8080/

    # WebSocket Support
    ProxyPass /ws ws://localhost:8080/ws
    ProxyPassReverse /ws ws://localhost:8080/ws

    # Logging
    ErrorLog ${APACHE_LOG_DIR}/meshmonitor-error.log
    CustomLog ${APACHE_LOG_DIR}/meshmonitor-access.log combined
</VirtualHost>
```

Enable required modules and the site:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl headers
sudo a2ensite meshmonitor
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## Traefik

Traefik is a modern reverse proxy designed for containerized environments.

### Docker Compose with Traefik

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt.acme.email=admin@example.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "./letsencrypt:/letsencrypt"
    networks:
      - app-network

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - SESSION_SECRET=your-secure-random-string
      - TRUST_PROXY=true  # Required when behind a reverse proxy
      - COOKIE_SECURE=true  # Enable secure cookies for HTTPS
      - ALLOWED_ORIGINS=https://meshmonitor.example.com  # REQUIRED for HTTPS!
    volumes:
      - meshmonitor-data:/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.meshmonitor.rule=Host(`meshmonitor.example.com`)"
      - "traefik.http.routers.meshmonitor.entrypoints=websecure"
      - "traefik.http.routers.meshmonitor.tls.certresolver=letsencrypt"
      - "traefik.http.services.meshmonitor.loadbalancer.server.port=8080"
      - "traefik.http.routers.meshmonitor-http.rule=Host(`meshmonitor.example.com`)"
      - "traefik.http.routers.meshmonitor-http.entrypoints=web"
      - "traefik.http.routers.meshmonitor-http.middlewares=redirect-to-https"
      - "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https"
    networks:
      - app-network

volumes:
  meshmonitor-data:

networks:
  app-network:
    driver: bridge
```

## Caddy

Caddy automatically handles HTTPS with Let's Encrypt.

### Caddyfile

Create a `Caddyfile`:

```caddy
meshmonitor.example.com {
    reverse_proxy localhost:8080

    # Security headers (automatic)
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
    }

    # Logging
    log {
        output file /var/log/caddy/meshmonitor.log
        format json
    }
}
```

Run Caddy:

```bash
caddy run --config Caddyfile
```

### Docker Compose with Caddy

```yaml
version: '3.8'

services:
  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - app-network

  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - SESSION_SECRET=your-secure-random-string
      - TRUST_PROXY=true  # Required when behind a reverse proxy
      - COOKIE_SECURE=true  # Enable secure cookies for HTTPS
      - ALLOWED_ORIGINS=https://meshmonitor.example.com  # REQUIRED for HTTPS!
    volumes:
      - meshmonitor-data:/data
    expose:
      - "8080"
    networks:
      - app-network

volumes:
  caddy_data:
  caddy_config:
  meshmonitor-data:

networks:
  app-network:
    driver: bridge
```

## Kubernetes Ingress

For Kubernetes deployments, use an Ingress controller.

### NGINX Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: meshmonitor-ingress
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - meshmonitor.example.com
    secretName: meshmonitor-tls
  rules:
  - host: meshmonitor.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: meshmonitor
            port:
              number: 8080
```

## Security Considerations

### Security Headers

Always include these security headers:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

### Rate Limiting

Protect against abuse with rate limiting:

**NGINX:**

```nginx
limit_req_zone $binary_remote_addr zone=meshmonitor:10m rate=10r/s;

server {
    location / {
        limit_req zone=meshmonitor burst=20 nodelay;
        proxy_pass http://localhost:8080;
    }
}
```

### IP Whitelisting

Restrict access to specific IPs if needed:

```nginx
location / {
    allow 192.168.1.0/24;
    allow 10.0.0.0/8;
    deny all;

    proxy_pass http://localhost:8080;
}
```

## Troubleshooting

### Blank White Page / 500 Errors on JavaScript Files

**Symptoms**:
- White blank page when accessing MeshMonitor
- 500 Internal Server Error on `/assets/index-*.js`
- Browser console shows CORS errors:
  ```
  Access to fetch at 'https://meshmonitor.example.com/api/...' has been blocked by CORS policy
  ```

**Cause**: Missing `ALLOWED_ORIGINS` environment variable

**Solution**: Add `ALLOWED_ORIGINS` to your docker-compose.yml or environment:

```bash
ALLOWED_ORIGINS=https://meshmonitor.example.com
```

**Multiple domains**: Separate with commas:
```bash
ALLOWED_ORIGINS=https://meshmonitor.example.com,https://mesh.example.org
```

**After adding**, restart MeshMonitor:
```bash
docker compose down
docker compose up -d
```

### Understanding CORS Errors

**What is CORS?**
Cross-Origin Resource Sharing (CORS) is a browser security feature that blocks JavaScript from making requests to a different origin (domain, protocol, or port) than where the page was loaded from.

**Why does it happen with HTTPS?**
When you access MeshMonitor via `https://meshmonitor.example.com`, but the API calls go to the backend, the browser considers them different origins and blocks the requests for security.

**How ALLOWED_ORIGINS fixes it:**
Setting `ALLOWED_ORIGINS=https://meshmonitor.example.com` tells the MeshMonitor backend to send proper CORS headers that allow the browser to make API requests from that domain.

**Checking CORS in browser console:**
1. Open browser DevTools (F12)
2. Go to Console tab
3. Look for errors containing "CORS policy" or "Access-Control-Allow-Origin"
4. If you see these, `ALLOWED_ORIGINS` is missing or incorrect

### 502 Bad Gateway

**Cause**: Backend not reachable

**Solution**:
- Verify MeshMonitor is running: `docker ps` or `systemctl status meshmonitor`
- Check firewall rules
- Verify proxy_pass URL is correct

### SSL Certificate Errors

**Cause**: Invalid or expired certificate

**Solution**:
- Check certificate validity: `openssl x509 -in cert.crt -text -noout`
- Renew Let's Encrypt: `sudo certbot renew`
- Verify certificate chain is complete

### WebSocket Connection Failed

**Cause**: Proxy not configured for WebSocket upgrade

**Solution**: Ensure these headers are set:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection 'upgrade';
```

### Login Works But Immediately Logs Out

**Cause**: Cookie security mismatch

**Solution**: Ensure both are set when using HTTPS:
```bash
TRUST_PROXY=true
COOKIE_SECURE=true
```

If using HTTP (not recommended), you must explicitly set:
```bash
COOKIE_SECURE=false
```

## Next Steps

- [Configure HTTP vs HTTPS](/configuration/http-vs-https) properly
- [Set up production deployment](/configuration/production) with monitoring
- [Configure SSO](/configuration/sso) with proper redirect URIs
