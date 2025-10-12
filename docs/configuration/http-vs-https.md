# HTTP vs HTTPS

Understanding when to use HTTP vs HTTPS and how to properly configure secure connections for MeshMonitor.

## Quick Summary

| Environment | Recommended Protocol | Why |
|-------------|---------------------|-----|
| **Local Development** | HTTP | Simple, no certificate needed |
| **Production** | HTTPS | Security, encryption, trust |
| **Internal Network** | HTTPS (preferred) | Best practice, protects from internal threats |
| **Public Internet** | HTTPS (required) | Absolutely necessary for security |

## HTTP (Unsecured)

### When to Use HTTP

- **Local development** on `localhost`
- **Testing** in isolated environments
- **Internal** networks with strict physical security (not recommended)

### Risks of HTTP

- **No encryption**: All data transmitted in plain text
- **Credentials exposed**: Passwords and session tokens visible
- **Man-in-the-middle attacks**: Easy to intercept and modify traffic
- **No authentication**: Cannot verify server identity
- **Browser warnings**: Modern browsers warn users about insecure sites

### HTTP Configuration

MeshMonitor runs on HTTP by default for development:

```yaml
services:
  meshmonitor:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
    ports:
      - "8080:8080"  # HTTP
```

Access at: `http://localhost:8080`

## HTTPS (Secured)

### When to Use HTTPS

- **Always** in production environments
- **Always** when accessible from the public internet
- **Preferred** even for internal networks
- **Required** for:
  - SSO/OIDC authentication
  - Handling sensitive data
  - Compliance requirements (HIPAA, PCI, etc.)

### Benefits of HTTPS

- **Encryption**: All traffic encrypted in transit
- **Authentication**: Verifies server identity via certificates
- **Data integrity**: Prevents tampering
- **Trust**: Browser shows secure padlock icon
- **SEO**: Search engines prefer HTTPS sites
- **Modern features**: Some browser APIs require HTTPS

## SSL/TLS Certificates

### Certificate Options

#### 1. Let's Encrypt (Free, Automated)

**Best for**: Public-facing websites

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d meshmonitor.example.com

# Auto-renewal
sudo certbot renew --dry-run
```

**Pros**:
- Free
- Automated renewal
- Trusted by all browsers
- Easy to set up

**Cons**:
- Requires public DNS
- 90-day validity (auto-renewal needed)

#### 2. Commercial Certificates

**Best for**: Enterprise deployments, extended validation

Purchase from:
- DigiCert
- Sectigo
- GoDaddy
- Namecheap

**Pros**:
- Longer validity (1-2 years)
- Better support
- Extended validation options
- Wildcard certificates

**Cons**:
- Cost
- Manual renewal process

#### 3. Self-Signed Certificates

**Best for**: Internal networks, development

Generate a self-signed certificate:

```bash
# Generate certificate
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -days 365 \
  -subj "/CN=meshmonitor.local"
```

**Pros**:
- Free
- No external dependencies
- Full control

**Cons**:
- Browser warnings
- Not trusted by default
- Manual trust configuration needed

#### 4. Internal Certificate Authority

**Best for**: Large organizations, multiple services

Use tools like:
- **OpenSSL**: Manual CA management
- **easy-rsa**: Simplified PKI
- **CFSSL**: CloudFlare's PKI toolkit
- **Step-ca**: Modern, automated CA

**Pros**:
- Centralized management
- Trust across organization
- No browser warnings (once CA is trusted)

**Cons**:
- Initial setup complexity
- Requires infrastructure

## Configuring HTTPS

### Option 1: Reverse Proxy (Recommended)

Use a reverse proxy for SSL termination:

**NGINX:**

```nginx
server {
    listen 443 ssl http2;
    server_name meshmonitor.example.com;

    ssl_certificate /etc/ssl/certs/meshmonitor.crt;
    ssl_certificate_key /etc/ssl/private/meshmonitor.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

See the [Reverse Proxy guide](/configuration/reverse-proxy) for complete setup.

### Option 2: Built-in Node.js HTTPS (Not Recommended for Production)

For development/testing only:

```javascript
import https from 'https';
import fs from 'fs';
import express from 'express';

const app = express();

const options = {
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
};

https.createServer(options, app).listen(8443);
```

**Note**: MeshMonitor currently doesn't include built-in HTTPS support. Use a reverse proxy instead.

### Option 3: Kubernetes with Cert-Manager

Automated certificate management in Kubernetes:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: meshmonitor-tls
spec:
  secretName: meshmonitor-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - meshmonitor.example.com
```

See the [Production Deployment guide](/configuration/production) for Kubernetes setup.

## Mixed Content Issues

When using HTTPS, avoid mixed content errors:

### The Problem

HTTPS pages cannot load HTTP resources (images, scripts, etc.) without browser warnings.

### Solutions

1. **Use relative URLs**: `src="/images/logo.png"` instead of `src="http://..."`
2. **Use protocol-relative URLs**: `src="//example.com/image.png"`
3. **Ensure all external resources use HTTPS**: Check CDN links, APIs, etc.

## HSTS (HTTP Strict Transport Security)

Force browsers to always use HTTPS:

```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
```

**Parameters**:
- `max-age`: How long (seconds) to enforce HTTPS
- `includeSubDomains`: Apply to all subdomains
- `preload`: Include in browser preload lists

**Warning**: Only enable `preload` if you're committed to HTTPS forever for your domain.

## Security Best Practices

### 1. Use Modern TLS Versions

Disable old protocols:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
```

Never use:
- SSLv2, SSLv3 (broken)
- TLSv1.0, TLSv1.1 (deprecated)

### 2. Strong Cipher Suites

Use secure ciphers:

```nginx
ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
ssl_prefer_server_ciphers on;
```

### 3. OCSP Stapling

Improve performance and privacy:

```nginx
ssl_stapling on;
ssl_stapling_verify on;
ssl_trusted_certificate /etc/ssl/certs/ca-bundle.crt;
```

### 4. Perfect Forward Secrecy

Generate strong DH parameters:

```bash
openssl dhparam -out /etc/ssl/certs/dhparam.pem 4096
```

```nginx
ssl_dhparam /etc/ssl/certs/dhparam.pem;
```

### 5. Secure Session Resumption

```nginx
ssl_session_cache shared:SSL:50m;
ssl_session_timeout 1d;
ssl_session_tickets off;
```

## Testing Your HTTPS Configuration

### Online Tools

- **SSL Labs**: https://www.ssllabs.com/ssltest/
  - Comprehensive SSL/TLS analysis
  - Grades your configuration
  - Identifies vulnerabilities

- **Security Headers**: https://securityheaders.com/
  - Checks security headers
  - Provides recommendations

### Command Line

Test certificate:

```bash
# View certificate details
openssl s_client -connect meshmonitor.example.com:443 -servername meshmonitor.example.com

# Check expiration
echo | openssl s_client -connect meshmonitor.example.com:443 2>/dev/null | openssl x509 -noout -dates
```

### Browser Developer Tools

1. Open DevTools (F12)
2. Go to Security tab
3. Check for:
   - Valid certificate
   - Secure connection
   - No mixed content warnings

## Certificate Renewal

### Let's Encrypt

Automatic renewal with Certbot:

```bash
# Test renewal
sudo certbot renew --dry-run

# Manual renewal
sudo certbot renew
```

Certbot typically sets up a systemd timer for automatic renewal.

### Commercial Certificates

1. Monitor expiration date
2. Purchase/generate renewal ~30 days before expiration
3. Install new certificate
4. Restart web server

### Monitoring

Set up monitoring for certificate expiration:

```bash
# Check expiration
openssl x509 -in /etc/ssl/certs/meshmonitor.crt -noout -enddate

# Alert if expiring in < 30 days
# (integrate with monitoring system)
```

## Troubleshooting

### Certificate Not Trusted

**Cause**: Self-signed certificate or incomplete chain

**Solution**:
- Use Let's Encrypt for public sites
- Import CA certificate for self-signed certs
- Ensure certificate chain is complete

### Mixed Content Warnings

**Cause**: HTTP resources on HTTPS page

**Solution**:
- Update all URLs to HTTPS
- Use relative URLs
- Check browser console for specific URLs

### ERR_CERT_COMMON_NAME_INVALID

**Cause**: Certificate hostname doesn't match

**Solution**:
- Regenerate certificate with correct hostname
- Add SANs (Subject Alternative Names) for multiple domains

### Connection Timeout

**Cause**: Firewall blocking port 443

**Solution**:
```bash
# Check if port is open
sudo netstat -tlnp | grep :443

# Test from external host
telnet meshmonitor.example.com 443
```

## Next Steps

- [Set up a reverse proxy](/configuration/reverse-proxy) for HTTPS
- [Configure SSO](/configuration/sso) (requires HTTPS)
- [Deploy to production](/configuration/production) with proper security
