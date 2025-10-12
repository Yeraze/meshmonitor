# Production Deployment

Best practices and recommendations for deploying MeshMonitor in production environments.

## Production Checklist

Before deploying to production, ensure:

- [ ] HTTPS is configured and working
- [ ] SSL/TLS certificates are valid and auto-renewing
- [ ] Strong `SESSION_SECRET` is set
- [ ] Database backups are configured
- [ ] Monitoring and alerting are set up
- [ ] Log aggregation is configured
- [ ] Reverse proxy is configured with security headers
- [ ] Firewall rules are properly configured
- [ ] SSO/OIDC is configured (if using)
- [ ] Resource limits are set appropriately
- [ ] High availability is configured (if required)

## Deployment Options

### Docker Compose (Small Scale)

For single-server deployments:

```yaml
version: '3.8'

services:
  meshmonitor:
    image: meshmonitor:latest
    restart: unless-stopped
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
      - SESSION_SECRET=${SESSION_SECRET}
      - NODE_ENV=production
      - OIDC_ISSUER=${OIDC_ISSUER}
      - OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
      - OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
      - OIDC_REDIRECT_URI=https://meshmonitor.example.com/api/auth/oidc/callback
    volumes:
      - meshmonitor_data:/app/data
    ports:
      - "127.0.0.1:8080:8080"  # Only bind to localhost
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  meshmonitor_data:
    driver: local
```

### Kubernetes with Helm (Enterprise Scale)

MeshMonitor includes Helm charts for Kubernetes deployment.

#### Install with Helm

```bash
# Add repository (if published)
helm repo add meshmonitor https://meshmonitor.org/charts
helm repo update

# Install
helm install meshmonitor meshmonitor/meshmonitor \
  --namespace meshmonitor \
  --create-namespace \
  --set meshmonitor.nodeIp=192.168.1.100 \
  --set ingress.enabled=true \
  --set ingress.host=meshmonitor.example.com \
  --set oidc.enabled=true \
  --set oidc.issuer=https://your-idp.com \
  --set oidc.clientId=your-client-id \
  --set oidc.clientSecret=your-client-secret
```

#### Custom values.yaml

```yaml
# values.yaml
meshmonitor:
  nodeIp: "192.168.1.100"
  sessionSecret: "generate-secure-random-string"

  resources:
    requests:
      memory: "256Mi"
      cpu: "100m"
    limits:
      memory: "512Mi"
      cpu: "500m"

  replicas: 2  # For high availability

persistence:
  enabled: true
  size: 10Gi
  storageClass: "standard"

oidc:
  enabled: true
  issuer: "https://your-idp.com"
  clientId: "your-client-id"
  clientSecret: "your-client-secret"
  redirectUri: "https://meshmonitor.example.com/api/auth/oidc/callback"

ingress:
  enabled: true
  className: "nginx"
  host: "meshmonitor.example.com"
  tls:
    enabled: true
    secretName: "meshmonitor-tls"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"

monitoring:
  enabled: true
  serviceMonitor: true
  grafana:
    enabled: true
  prometheus:
    enabled: true
```

Deploy:

```bash
helm install meshmonitor ./helm/meshmonitor -f values.yaml
```

## High Availability

### Load Balancing

Run multiple instances behind a load balancer:

**Docker Compose:**

```yaml
version: '3.8'

services:
  meshmonitor-1:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
    volumes:
      - meshmonitor_data:/app/data
    expose:
      - "8080"
    networks:
      - app-network

  meshmonitor-2:
    image: meshmonitor:latest
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100
    volumes:
      - meshmonitor_data:/app/data
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
      - ./nginx-lb.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - meshmonitor-1
      - meshmonitor-2
    networks:
      - app-network

volumes:
  meshmonitor_data:

networks:
  app-network:
```

**NGINX Load Balancer Config:**

```nginx
upstream meshmonitor_backend {
    least_conn;  # Load balancing method
    server meshmonitor-1:8080 max_fails=3 fail_timeout=30s;
    server meshmonitor-2:8080 max_fails=3 fail_timeout=30s;
}

server {
    listen 443 ssl http2;
    server_name meshmonitor.example.com;

    # SSL config...

    location / {
        proxy_pass http://meshmonitor_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # Session stickiness
        proxy_set_header Connection "";
        proxy_http_version 1.1;
    }
}
```

### Session Management

For multiple instances, sessions must be shared:

**Options:**
1. **Sticky sessions** (session affinity) - Route users to same instance
2. **Shared session store** - Redis, Memcached, or database
3. **JWT tokens** - Stateless authentication

MeshMonitor uses SQLite for sessions by default, which works with sticky sessions.

## Security Hardening

### Environment Variables

Never hardcode secrets:

```bash
# Generate secure session secret
openssl rand -base64 32

# Store in .env file (never commit!)
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
```

### Firewall Configuration

**UFW (Ubuntu):**

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Deny direct access to app port
sudo ufw deny 8080/tcp

# Enable firewall
sudo ufw enable
```

**iptables:**

```bash
# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# Allow HTTP/HTTPS
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Deny app port from external
iptables -A INPUT -p tcp --dport 8080 -j DROP

# Allow loopback
iptables -A INPUT -i lo -j ACCEPT
```

### Docker Security

Run as non-root user:

```dockerfile
# In Dockerfile
USER node
```

Limit container capabilities:

```yaml
services:
  meshmonitor:
    image: meshmonitor:latest
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
```

### Kubernetes Security

Pod Security Policy:

```yaml
apiVersion: policy/v1beta1
kind:PodSecurityPolicy
metadata:
  name: meshmonitor-psp
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'RunAsAny'
  fsGroup:
    rule: 'RunAsAny'
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'persistentVolumeClaim'
    - 'secret'
```

## Backups

### Database Backups

**Automated backup script:**

```bash
#!/bin/bash
# backup-meshmonitor.sh

BACKUP_DIR="/backups/meshmonitor"
DATE=$(date +%Y%m%d-%H%M%S)
CONTAINER="meshmonitor"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Backup database
docker cp "$CONTAINER:/app/data/meshmonitor.db" \
  "$BACKUP_DIR/meshmonitor-$DATE.db"

# Compress
gzip "$BACKUP_DIR/meshmonitor-$DATE.db"

# Keep only last 30 days
find "$BACKUP_DIR" -name "*.db.gz" -mtime +30 -delete

echo "Backup completed: meshmonitor-$DATE.db.gz"
```

**Cron job:**

```bash
# Run daily at 2 AM
0 2 * * * /usr/local/bin/backup-meshmonitor.sh
```

**Kubernetes CronJob:**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: meshmonitor-backup
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: alpine:latest
            command:
            - /bin/sh
            - -c
            - |
              apk add --no-cache sqlite
              sqlite3 /data/meshmonitor.db ".backup '/backup/meshmonitor-$(date +%Y%m%d).db'"
              gzip /backup/meshmonitor-$(date +%Y%m%d).db
            volumeMounts:
            - name: data
              mountPath: /data
            - name: backup
              mountPath: /backup
          restartPolicy: OnFailure
          volumes:
          - name: data
            persistentVolumeClaim:
              claimName: meshmonitor-data
          - name: backup
            persistentVolumeClaim:
              claimName: meshmonitor-backup
```

### Restore from Backup

```bash
# Stop MeshMonitor
docker compose down

# Restore database
gunzip -c /backups/meshmonitor-20241012.db.gz > data/meshmonitor.db

# Start MeshMonitor
docker compose up -d
```

## Monitoring

### Health Checks

MeshMonitor provides health check endpoints:

```bash
# Basic health check
curl http://localhost:8080/api/health

# Detailed status
curl http://localhost:8080/api/status
```

### Prometheus Metrics

If monitoring is enabled, metrics are available at:

```
http://localhost:8080/metrics
```

**Prometheus scrape config:**

```yaml
scrape_configs:
  - job_name: 'meshmonitor'
    static_configs:
      - targets: ['meshmonitor.example.com:8080']
    metrics_path: '/metrics'
```

### Grafana Dashboard

Import the included Grafana dashboard:

1. Navigate to Grafana → Dashboards → Import
2. Upload `monitoring/grafana-dashboard.json`
3. Select Prometheus data source

### Log Aggregation

**ELK Stack:**

```yaml
services:
  meshmonitor:
    logging:
      driver: "fluentd"
      options:
        fluentd-address: "localhost:24224"
        tag: "meshmonitor"
```

**Loki:**

```yaml
services:
  meshmonitor:
    logging:
      driver: "loki"
      options:
        loki-url: "http://loki:3100/loki/api/v1/push"
```

### Alerting

**Prometheus AlertManager rules:**

```yaml
groups:
- name: meshmonitor
  rules:
  - alert: MeshMonitorDown
    expr: up{job="meshmonitor"} == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "MeshMonitor is down"
      description: "MeshMonitor has been down for more than 5 minutes."

  - alert: HighMemoryUsage
    expr: container_memory_usage_bytes{name="meshmonitor"} > 512000000
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "High memory usage"
      description: "MeshMonitor is using more than 512MB of memory."
```

## Performance Optimization

### Resource Limits

Set appropriate resource limits:

**Docker:**

```yaml
services:
  meshmonitor:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

**Kubernetes:**

```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "250m"
  limits:
    memory: "512Mi"
    cpu: "1000m"
```

### Database Optimization

Enable WAL mode for better performance:

```bash
sqlite3 data/meshmonitor.db "PRAGMA journal_mode=WAL;"
```

### Caching

Enable caching at the reverse proxy level (see [Reverse Proxy guide](/configuration/reverse-proxy)).

## Updates and Maintenance

### Rolling Updates

**Docker Compose:**

```bash
# Pull new image
docker compose pull

# Recreate containers with zero downtime
docker compose up -d --no-deps --build meshmonitor
```

**Kubernetes:**

```bash
# Update deployment
helm upgrade meshmonitor ./helm/meshmonitor -f values.yaml

# Or with kubectl
kubectl set image deployment/meshmonitor meshmonitor=meshmonitor:v2.0.0

# Monitor rollout
kubectl rollout status deployment/meshmonitor
```

### Maintenance Windows

For major updates:

1. Notify users of maintenance window
2. Enable maintenance mode (if available)
3. Backup database
4. Perform update
5. Test functionality
6. Restore service

## Disaster Recovery

### Backup Strategy

Follow the 3-2-1 rule:
- **3** copies of data
- **2** different storage media
- **1** off-site backup

### Recovery Time Objective (RTO)

Target: < 1 hour

1. Deploy fresh instance
2. Restore database from backup
3. Verify functionality
4. Update DNS if needed

### Testing Recovery

Regularly test your recovery procedure:

```bash
# Test restoration in a separate environment
docker compose -f docker-compose.test.yml up -d
docker cp backup.db meshmonitor-test:/app/data/meshmonitor.db
# Verify data integrity
```

## Compliance

### GDPR Considerations

- Implement data retention policies
- Provide user data export
- Enable account deletion
- Log access to personal data

### Audit Logging

Enable comprehensive audit logging:

```bash
# View authentication logs
docker logs meshmonitor | grep "auth"

# View all API access
docker logs meshmonitor | grep "api"
```

## Troubleshooting

### High CPU Usage

Check for:
- Long-running queries
- Memory leaks
- Excessive logging

```bash
# Docker stats
docker stats meshmonitor

# Top processes in container
docker exec meshmonitor top
```

### Database Locked

SQLite database locked errors:

```bash
# Enable WAL mode
sqlite3 data/meshmonitor.db "PRAGMA journal_mode=WAL;"

# Increase busy timeout
sqlite3 data/meshmonitor.db "PRAGMA busy_timeout=30000;"
```

### Out of Memory

Increase memory limits or optimize queries.

## Next Steps

- Configure [monitoring and alerting](#monitoring)
- Set up [automated backups](#backups)
- Review [security hardening](#security-hardening)
- Test [disaster recovery](#disaster-recovery) procedures
