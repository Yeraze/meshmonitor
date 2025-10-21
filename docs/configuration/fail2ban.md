# Fail2ban Integration

Protect your MeshMonitor instance from brute-force attacks and unauthorized access attempts using fail2ban. This guide covers setup, configuration, and integration with abuse reporting services.

## Overview

Fail2ban monitors log files for suspicious activity (like failed login attempts) and automatically bans offending IP addresses by updating firewall rules. When integrated with MeshMonitor's access logging, it provides:

- **Automatic IP banning** after repeated failed logins
- **Reduced attack surface** by blocking malicious IPs
- **Abuse reporting** integration with AbuseIPDB
- **Protection against** brute-force, credential stuffing, and automated attacks

## Prerequisites

- MeshMonitor deployed with access logging enabled
- fail2ban installed on the host system
- Root/sudo access to configure fail2ban
- (Optional) AbuseIPDB API key for abuse reporting

## Enable Access Logging

First, enable access logging in MeshMonitor by setting environment variables:

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    environment:
      - ACCESS_LOG_ENABLED=true
      - ACCESS_LOG_PATH=/data/logs/access.log
      - ACCESS_LOG_FORMAT=combined  # Apache Combined Log Format
    volumes:
      - meshmonitor-data:/data
      - ./meshmonitor-logs:/data/logs:rw  # Bind mount for fail2ban
```

**Important**: The logs must be accessible from the host filesystem. Use a bind mount (`./meshmonitor-logs:/data/logs:rw`), not a named Docker volume.

Restart MeshMonitor:

```bash
docker compose down
docker compose up -d
```

Verify logging is working:

```bash
tail -f ./meshmonitor-logs/access.log
```

You should see entries like:

```
192.168.1.100 - admin [21/Oct/2025:10:05:00 +0000] "POST /api/auth/login HTTP/1.1" 200 1234 "https://meshmonitor.example.com/login" "Mozilla/5.0..."
192.168.1.50 - - [21/Oct/2025:10:05:15 +0000] "POST /api/auth/login HTTP/1.1" 401 45 "https://meshmonitor.example.com/login" "curl/7.68.0"
```

## Install Fail2ban

### Ubuntu/Debian

```bash
sudo apt update
sudo apt install fail2ban
```

### CentOS/RHEL

```bash
sudo yum install epel-release
sudo yum install fail2ban
```

### Verify Installation

```bash
sudo systemctl status fail2ban
```

## Configure Fail2ban

### Create Filter

Create `/etc/fail2ban/filter.d/meshmonitor.conf`:

```ini
[Definition]

# Detect failed login attempts (401 Unauthorized)
failregex = ^<HOST> .* "POST /api/auth/login HTTP/.*" 401
            ^<HOST> .* "POST /api/auth/login HTTP/.*" 403

# Ignore successful logins
ignoreregex =
```

**What this does**:
- Matches HTTP 401 (Unauthorized) and 403 (Forbidden) responses to `/api/auth/login`
- Extracts the IP address from the Apache Combined Log Format
- Ignores successful logins (200 status)

### Create Jail

Create `/etc/fail2ban/jail.d/meshmonitor.conf`:

```ini
[meshmonitor]
enabled = true
port = http,https
filter = meshmonitor
logpath = /path/to/meshmonitor-logs/access.log
maxretry = 5
findtime = 600
bantime = 3600
action = iptables-multiport[name=meshmonitor, port="http,https"]
```

**Configuration explained**:
- `enabled = true`: Activate this jail
- `port = http,https`: Protect both HTTP and HTTPS
- `filter = meshmonitor`: Use the filter we created above
- `logpath = /path/to/meshmonitor-logs/access.log`: **UPDATE THIS** to your actual log path
- `maxretry = 5`: Ban after 5 failed attempts
- `findtime = 600`: Within 10 minutes (600 seconds)
- `bantime = 3600`: Ban for 1 hour (3600 seconds)
- `action`: Use iptables to block the IP

**Update the logpath**: Replace `/path/to/meshmonitor-logs/access.log` with the actual path on your system. For example:

```ini
logpath = /home/user/meshmonitor/meshmonitor-logs/access.log
```

### Recommended Adjustments

For production deployments, consider:

```ini
maxretry = 3          # Stricter: ban after 3 attempts
findtime = 300        # Within 5 minutes
bantime = 86400       # Ban for 24 hours
```

For development/testing:

```ini
maxretry = 10
findtime = 1200
bantime = 600         # 10 minute ban for testing
```

### Test Filter

Before enabling, test the filter against your logs:

```bash
sudo fail2ban-regex /path/to/meshmonitor-logs/access.log /etc/fail2ban/filter.d/meshmonitor.conf
```

You should see output like:

```
Success, the total number of match is 5

Failregex: 5 total
|-  #) [# of hits] regular expression
|   1) [5] ^<HOST> .* "POST /api/auth/login HTTP/.*" 401
`-

Ignoreregex: 0 total
```

## Enable and Start

Restart fail2ban to apply changes:

```bash
sudo systemctl restart fail2ban
sudo systemctl enable fail2ban
```

Check jail status:

```bash
sudo fail2ban-client status meshmonitor
```

Output:

```
Status for the jail: meshmonitor
|- Filter
|  |- Currently failed: 2
|  |- Total failed:     15
|  `- File list:        /home/user/meshmonitor/meshmonitor-logs/access.log
`- Actions
   |- Currently banned: 1
   |- Total banned:     3
   `- Banned IP list:   192.168.1.50
```

## Testing

### Simulate Failed Login

Test the configuration by intentionally failing to log in:

```bash
# Attempt login with wrong password multiple times
curl -X POST https://meshmonitor.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"wrongpassword"}'
```

Repeat 5+ times (based on your `maxretry` setting).

Check if your IP was banned:

```bash
sudo fail2ban-client status meshmonitor
```

### Unban an IP

If you accidentally ban yourself:

```bash
sudo fail2ban-client set meshmonitor unbanip YOUR.IP.ADDRESS.HERE
```

### View Logs

Monitor fail2ban activity:

```bash
sudo tail -f /var/log/fail2ban.log
```

You'll see entries like:

```
2025-10-21 10:05:20,123 fail2ban.filter [1234]: INFO [meshmonitor] Found 192.168.1.50 - 2025-10-21 10:05:15
2025-10-21 10:05:25,456 fail2ban.actions [1234]: NOTICE [meshmonitor] Ban 192.168.1.50
```

## AbuseIPDB Integration

Report banned IPs to AbuseIPDB to help protect the broader internet community.

### Get API Key

1. Sign up at https://www.abuseipdb.com/
2. Generate an API key from your account settings
3. Note the key for configuration

### Configure Action

Create `/etc/fail2ban/action.d/abuseipdb.conf`:

```ini
[Definition]

# Report IP to AbuseIPDB
actionban = curl -s https://api.abuseipdb.com/api/v2/report \
            -H "Key: YOUR_ABUSEIPDB_API_KEY_HERE" \
            -H "Accept: application/json" \
            --data-urlencode "ip=<ip>" \
            --data-urlencode "categories=18,21" \
            --data-urlencode "comment=MeshMonitor: Failed login attempts"

# No action needed on unban
actionunban =

[Init]
# Required but not used
name = default
```

**Replace** `YOUR_ABUSEIPDB_API_KEY_HERE` with your actual API key.

**Categories**:
- 18: Brute-Force
- 21: Web App Attack

### Update Jail

Modify `/etc/fail2ban/jail.d/meshmonitor.conf` to include AbuseIPDB reporting:

```ini
[meshmonitor]
enabled = true
port = http,https
filter = meshmonitor
logpath = /path/to/meshmonitor-logs/access.log
maxretry = 5
findtime = 600
bantime = 3600
action = iptables-multiport[name=meshmonitor, port="http,https"]
         abuseipdb
```

Restart fail2ban:

```bash
sudo systemctl restart fail2ban
```

## Advanced Configuration

### Whitelist IPs

Never ban trusted IPs (like your home/office):

Add to `/etc/fail2ban/jail.d/meshmonitor.conf`:

```ini
[meshmonitor]
# ... existing config ...
ignoreip = 127.0.0.1/8 ::1
           192.168.1.0/24    # Your home network
           10.0.0.0/8        # VPN network
```

### Email Notifications

Get notified when IPs are banned:

Install mail utilities:

```bash
sudo apt install mailutils
```

Update action in `/etc/fail2ban/jail.d/meshmonitor.conf`:

```ini
action = iptables-multiport[name=meshmonitor, port="http,https"]
         sendmail-whois[name=meshmonitor, dest=admin@example.com]
```

### Persistent Bans

Ban repeat offenders permanently:

Create `/etc/fail2ban/action.d/iptables-persistent.conf`:

```ini
[Definition]

actionstart = iptables -N f2b-meshmonitor-perm
              iptables -A f2b-meshmonitor-perm -j RETURN
              iptables -I INPUT -p tcp -m multiport --dports http,https -j f2b-meshmonitor-perm

actionstop = iptables -D INPUT -p tcp -m multiport --dports http,https -j f2b-meshmonitor-perm
             iptables -F f2b-meshmonitor-perm
             iptables -X f2b-meshmonitor-perm

actionban = iptables -I f2b-meshmonitor-perm 1 -s <ip> -j DROP
            echo "<ip>" >> /etc/fail2ban/persistent-bans-meshmonitor.txt

actionunban = iptables -D f2b-meshmonitor-perm -s <ip> -j DROP
              sed -i '/<ip>/d' /etc/fail2ban/persistent-bans-meshmonitor.txt
```

## Troubleshooting

### Logs Not Being Monitored

**Check log path**:

```bash
sudo fail2ban-client get meshmonitor logpath
```

**Verify file permissions**:

```bash
ls -la /path/to/meshmonitor-logs/access.log
```

Fail2ban must be able to read the file. If needed:

```bash
sudo chmod 644 /path/to/meshmonitor-logs/access.log
```

### Filter Not Matching

**Test regex**:

```bash
sudo fail2ban-regex /path/to/meshmonitor-logs/access.log /etc/fail2ban/filter.d/meshmonitor.conf --print-all-matched
```

**Check log format**: Ensure `ACCESS_LOG_FORMAT=combined` in MeshMonitor configuration.

### Fail2ban Not Starting

**Check configuration syntax**:

```bash
sudo fail2ban-client --test
```

**View error logs**:

```bash
sudo journalctl -u fail2ban -n 50
```

### Accidentally Banned Yourself

**Unban your IP**:

```bash
sudo fail2ban-client set meshmonitor unbanip YOUR.IP.HERE
```

**Check current bans**:

```bash
sudo iptables -L -n | grep DROP
```

## Performance Considerations

Access logging has minimal performance impact:

- **Overhead**: ~1-2% for typical workloads
- **Disk space**: ~1MB per 10,000 requests (before compression)
- **Log rotation**: Automatic daily rotation, keeps 14 days
- **Compression**: Old logs compressed with gzip (~90% reduction)

For high-traffic deployments (>10,000 req/day):

```yaml
environment:
  - ACCESS_LOG_FORMAT=tiny  # Minimal format, less disk I/O
```

## Security Best Practices

1. **Use strong passwords**: fail2ban is a last line of defense
2. **Monitor regularly**: Check `sudo fail2ban-client status meshmonitor` weekly
3. **Review bans**: Investigate patterns in `/var/log/fail2ban.log`
4. **Update regularly**: Keep fail2ban and MeshMonitor updated
5. **Combine with rate limiting**: MeshMonitor has built-in rate limiting
6. **Enable HTTPS**: Always use TLS in production
7. **Whitelist carefully**: Only add trusted networks to `ignoreip`

## Integration with Reverse Proxies

### Behind NGINX/Caddy/Traefik

The access log captures the actual client IP when `TRUST_PROXY=true` is set. Verify with:

```bash
tail -f /path/to/meshmonitor-logs/access.log
```

The first field should be the real client IP, not the proxy IP (127.0.0.1).

### With Cloudflare

If using Cloudflare, you may see Cloudflare IPs instead of real client IPs. To fix:

1. Ensure Cloudflare is sending `CF-Connecting-IP` header
2. Configure NGINX/Caddy to use real IP module
3. Set `TRUST_PROXY=true` in MeshMonitor

Alternatively, use Cloudflare's own firewall rules instead of fail2ban.

## Uninstalling

To disable fail2ban for MeshMonitor:

```bash
# Disable jail
sudo fail2ban-client stop meshmonitor

# Remove configuration
sudo rm /etc/fail2ban/jail.d/meshmonitor.conf
sudo rm /etc/fail2ban/filter.d/meshmonitor.conf

# Restart fail2ban
sudo systemctl restart fail2ban
```

To disable access logging in MeshMonitor:

```yaml
environment:
  - ACCESS_LOG_ENABLED=false  # or remove this line entirely
```

Remove the logs bind mount from docker-compose.yml and restart.

## Additional Resources

- [fail2ban Documentation](https://fail2ban.readthedocs.io/)
- [AbuseIPDB Documentation](https://docs.abuseipdb.com/)
- [MeshMonitor Security Guide](/docs/configuration/production)
- [Reverse Proxy Configuration](/docs/configuration/reverse-proxy)

## Support

If you encounter issues:

1. Test the filter with `fail2ban-regex`
2. Check `/var/log/fail2ban.log` for errors
3. Verify log path and permissions
4. Open an issue on [GitHub](https://github.com/yeraze/meshmonitor/issues)
