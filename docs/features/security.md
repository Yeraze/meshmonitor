# Security Features

MeshMonitor includes advanced security monitoring features to help you identify and manage potential security issues in your mesh network. These features automatically detect common security vulnerabilities and provide filtering tools to manage flagged nodes.

![Security Scanner](/images/features/security.png)

## Overview

The security monitoring system automatically detects two types of security issues:

1. **Low-Entropy Public Keys**: Known weak encryption keys that are publicly documented
2. **Duplicate Public Keys**: Multiple nodes sharing the same encryption key (a significant security risk)

When security issues are detected, nodes are flagged with warning indicators throughout the interface, allowing you to quickly identify and address potential vulnerabilities.

## Security Detection

### Low-Entropy Key Detection

**What it detects**: Nodes using publicly known weak encryption keys that have been documented in security databases.

**Why it matters**: Some Meshtastic devices ship with default or predictable encryption keys. These "low-entropy" keys provide minimal security since they can be easily discovered or guessed by anyone. Nodes using these keys can have their communications intercepted and decrypted.

**How it works**:
- MeshMonitor maintains a database of known weak public keys
- When a node broadcasts its public key, it's compared against this database
- If a match is found, the node is automatically flagged with `keyIsLowEntropy = true`
- The database includes keys from various sources including documented default keys and discovered weak keys

**Detection frequency**: Checked in real-time as nodes are discovered or updated

### Duplicate Key Detection

**What it detects**: Multiple nodes sharing the same public encryption key.

**Why it matters**: Each node should have a unique public key. When multiple nodes share the same key:
- It indicates possible device cloning or key copying
- It can allow one device to impersonate another
- It creates confusion in encrypted communications
- It's a strong indicator of either misconfiguration or malicious activity

**How it works**:
- A background scanner runs periodically (default: every 24 hours)
- All nodes with public keys are analyzed
- Public keys are hashed and compared to find duplicates
- When duplicates are found, all affected nodes are flagged with `duplicateKeyDetected = true`
- Detailed information about which nodes share each key is stored

**Detection frequency**:
- Initial scan: 5 minutes after server start
- Recurring scans: Every 24 hours (configurable via `DUPLICATE_KEY_SCAN_INTERVAL_HOURS` environment variable)
- Manual scans: Can be triggered via the `/api/nodes/scan-duplicate-keys` endpoint

**Configuration**:
```bash
# docker-compose.yml or environment configuration
environment:
  - DUPLICATE_KEY_SCAN_INTERVAL_HOURS=24  # Adjust scan frequency (1-168 hours)
```

### Combined Detection

When a node has both a low-entropy key AND it's shared with other nodes:
- Both flags are set (`keyIsLowEntropy = true` and `duplicateKeyDetected = true`)
- Security details indicate both issues
- The node is considered a high-priority security concern

## Visual Indicators

Security issues are displayed throughout the interface with clear visual indicators:

### Node List (Nodes Tab)

**Warning Icon**: Nodes with security issues display a ⚠️ warning icon next to their name

**Icon Position**: Appears after the node name in the node list

**Hover Tooltip**: Hovering over the warning icon shows:
- "Low-entropy key detected" (for low-entropy keys)
- "Duplicate key detected" (for duplicate keys)
- Combined message (when both issues present)

### Messages Tab

**Red Warning Bar**: When viewing messages from a flagged node, a prominent red warning bar appears at the top of the conversation

**Warning Bar Content**:
- Clear security alert message
- Specific details about the security issue
- List of other nodes sharing the same key (for duplicate key issues)
- Clickable node names that navigate to those nodes in the list

**Example Warning Messages**:
- "⚠️ Security Alert: This node is using a known low-entropy public key. Communications may not be secure."
- "⚠️ Security Alert: This node's public key is shared with other nodes: 12345678, 87654321. This is a significant security risk."
- "⚠️ Security Alert: This node is using a known low-entropy key that is also shared with other nodes: 12345678, 87654321."

### Security Details Section

**Location**: Below the warning bar in the Messages tab

**Content**:
- Human-readable explanation of the security issue
- Technical details stored in `keySecurityIssueDetails`
- List of affected nodes (for duplicate keys) with clickable links

**Example Details**:
- "Known low-entropy key detected"
- "Key shared with nodes: 12345678, 87654321"
- "Known low-entropy key; Key shared with nodes: 12345678, 87654321"

## Security Filtering

The Security Filter allows you to show or hide flagged nodes throughout the interface.

### Accessing the Security Filter

**Location**: Filter Modal popup (available on both Nodes and Messages tabs)

**How to Access**:
1. Click the "Filter" button in the sidebar (on Nodes or Messages tab)
2. The Filter Modal will open
3. Find the "Security" section (marked with ⚠️ icon)

### Filter Options

The Security Filter provides three radio button options:

**All Nodes** (default)
- Shows all nodes regardless of security status
- Flagged nodes still display warning icons
- No filtering applied

**⚠️ Flagged Only**
- Shows ONLY nodes with security issues
- Filters to nodes where `keyIsLowEntropy = true` OR `duplicateKeyDetected = true`
- Useful for security audits and reviewing all problematic nodes
- Node count updates to show "X/Total" format (e.g., "8/156 nodes")

**Hide Flagged**
- Hides all nodes with security issues from the list
- Shows only nodes with no known security problems
- Useful for focusing on trusted nodes
- Node count updates to show remaining clean nodes

### Filter Behavior

**Applies To**:
- Node list in the Nodes tab
- Node list in the Messages tab sidebar
- Node count displays

**Persistence**:
- Filter selection persists during your session
- Stored in React context state (not localStorage)
- Resets to "All Nodes" on page refresh

**Interaction with Other Filters**:
- Works alongside text-based node name filtering
- Combines with "Unknown Nodes" filter
- Combines with "Device Role" filter
- All filters are applied together (logical AND)

**Real-time Updates**:
- If new nodes are flagged while you're viewing, they'll appear/disappear based on current filter
- Filter state is shared between Nodes and Messages tabs

## Database Schema

Security information is stored in the `nodes` table:

```sql
-- Security-related columns
keyIsLowEntropy INTEGER DEFAULT 0           -- Boolean flag (0 or 1)
duplicateKeyDetected INTEGER DEFAULT 0      -- Boolean flag (0 or 1)
keySecurityIssueDetails TEXT                -- Human-readable details
publicKey TEXT                              -- Base64-encoded public key
```

**Field Details**:

- `keyIsLowEntropy`: Set to 1 when the node's public key matches a known weak key
- `duplicateKeyDetected`: Set to 1 when the node's public key is shared with other nodes
- `keySecurityIssueDetails`: Stores detailed information like "Key shared with nodes: 123, 456"
- `publicKey`: The actual public key (base64-encoded, 32 bytes when decoded)

## API Endpoints

### Manual Duplicate Key Scan

Trigger a manual scan for duplicate keys:

```bash
POST /api/nodes/scan-duplicate-keys
```

**Authentication**: Requires `nodes:write` permission

**Response**:
```json
{
  "success": true,
  "message": "Duplicate key scan completed",
  "flaggedNodes": 8,
  "duplicateGroups": 2
}
```

**Use Cases**:
- Immediate scan after adding new nodes
- Verification after key rotation
- Troubleshooting security alerts

### Get Nodes with Security Issues

Retrieve all nodes currently flagged with security issues:

```bash
GET /api/nodes/security-issues
```

**Response**:
```json
{
  "nodes": [
    {
      "nodeNum": 123456789,
      "nodeId": "!12345678",
      "longName": "Node Name",
      "keyIsLowEntropy": true,
      "duplicateKeyDetected": false,
      "keySecurityIssueDetails": "Known low-entropy key detected"
    }
  ],
  "count": 1
}
```

## Best Practices

### For Network Administrators

1. **Regular Monitoring**:
   - Check the "⚠️ Flagged Only" filter periodically
   - Review security warnings in the Messages tab
   - Monitor for new flagged nodes after network changes

2. **Key Rotation**:
   - Nodes with low-entropy keys should have their keys regenerated
   - Use Meshtastic CLI or app to generate new keys
   - Verify flags clear after key rotation

3. **Duplicate Key Investigation**:
   - Duplicate keys may indicate:
     - Device cloning attempts
     - Misconfigured backup/restore procedures
     - Factory reset devices reusing old keys
   - Investigate the source of duplicates before clearing flags

4. **Scan Frequency**:
   - Default 24-hour scan interval is suitable for most networks
   - High-security networks may want shorter intervals (6-12 hours)
   - Large networks may prefer longer intervals to reduce load

### For Users

1. **Understand Warning Icons**:
   - ⚠️ icon means the node has a known security issue
   - Hover to see specific details
   - Communications with flagged nodes may not be secure

2. **Review Your Own Nodes**:
   - Check if any of your nodes are flagged
   - Regenerate keys on flagged devices
   - Ensure each device has a unique key

3. **Report Suspicious Activity**:
   - Multiple nodes with duplicate keys may indicate malicious activity
   - Contact network administrators if you see unusual patterns
   - Document node IDs and timestamps

## Troubleshooting

### False Positives

**Issue**: A node is flagged but you believe it's secure

**Solutions**:
- Verify the node's public key hasn't been documented as weak
- Check if the key is truly unique in your network
- Consider regenerating the key to clear the flag
- Contact MeshMonitor developers if you believe it's a false positive

### Flags Not Clearing

**Issue**: Fixed a node's key but the flag remains

**Solutions**:
- Wait for the next scheduled scan (up to 24 hours)
- Trigger a manual scan via `/api/nodes/scan-duplicate-keys`
- Verify the node has broadcasted its new public key
- Check server logs for scan errors

### Scanner Not Running

**Issue**: Duplicate keys aren't being detected

**Solutions**:
- Check server logs for `🔐` emoji messages
- Verify the scanner started: Look for "Starting duplicate key scanner"
- Check environment variable `DUPLICATE_KEY_SCAN_INTERVAL_HOURS`
- Restart the server to reinitialize the scanner

**Diagnostic Commands**:
```bash
# Get nodes with security issues
curl http://localhost:8080/api/nodes/security-issues

# View scanner logs (Docker)
docker logs meshmonitor 2>&1 | grep "🔐"

# Trigger manual scan
curl -X POST http://localhost:8080/api/nodes/scan-duplicate-keys
```

## Security Considerations

### Data Privacy

- Public keys are stored in the database for comparison
- Key hashes are generated but not stored
- No private keys are ever transmitted or stored
- Security flags are visible to all authenticated users

### Performance Impact

- Key detection is real-time but very fast (hash comparison)
- Duplicate key scanning runs in the background
- Large networks (>1000 nodes) may take longer to scan
- Scanner uses minimal CPU and memory

### Limitations

- Only detects known low-entropy keys in the database
- Cannot detect newly created weak keys
- Requires nodes to broadcast their public keys
- Scanner only runs while server is running

## Two-Factor Authentication (MFA)

MeshMonitor supports TOTP-based two-factor authentication (MFA) for user accounts, adding an extra layer of security beyond username and password.

### Overview

When MFA is enabled on an account, logging in requires both a password and a time-based one-time password (TOTP) generated by an authenticator app such as Google Authenticator, Authy, or any TOTP-compatible app.

### Setting Up MFA

1. Navigate to **Settings > Security**
2. Click **Enable MFA**
3. Scan the QR code with your authenticator app (or manually enter the secret key)
4. Enter the 6-digit verification code from your app to confirm setup
5. Save the backup codes displayed after successful setup

### Backup Codes

During MFA setup, you receive **10 single-use backup codes**. These are your recovery method if you lose access to your authenticator app.

- Each code is 8 characters (uppercase hexadecimal)
- Each code can only be used once
- Store them securely — they are not shown again after initial setup
- If you run out of backup codes, an admin can disable MFA on your account so you can re-enroll

### Login Flow

With MFA enabled, the login process has two steps:

1. Enter your username and password as usual
2. On the next screen, enter the 6-digit TOTP code from your authenticator app

The code changes every 30 seconds. Enter the current code displayed in your app.

### Admin Controls

Administrators can disable MFA for any user account. This is useful when a user has lost access to both their authenticator app and backup codes. After an admin disables MFA, the user can log in with just their password and optionally re-enable MFA.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mfa/status` | Check if MFA is enabled for the current user |
| `POST` | `/api/mfa/setup` | Begin MFA enrollment (returns QR code and secret) |
| `POST` | `/api/mfa/verify-setup` | Complete enrollment by verifying a TOTP code |
| `POST` | `/api/mfa/disable` | Disable MFA for the current user (or admin disabling for another user) |

All endpoints require authentication. Setup and verification endpoints are rate-limited.

## Related Documentation

- [API Documentation](/development/api) - API reference and examples
- [Settings](/features/settings) - General settings and configuration
- [Production Deployment](/configuration/production) - Security best practices for production
- [Database Schema](https://github.com/Yeraze/meshmonitor/blob/main/docs/database/SCHEMA.md) - Complete database structure

## Future Enhancements

Planned security features for future releases:

- Configurable low-entropy key database updates
- Security alert notifications (email, push, webhooks)
- Automatic key rotation recommendations
- Network-wide security score calculation
- Integration with Meshtastic security advisories
- Historical security event logging
