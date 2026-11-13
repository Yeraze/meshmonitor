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

**Meshtastic 2.8 upgrade exception** (issue #4251): a firmware regression in 2.8 renumbers a node to `crc32(publicKey)` on its first 2.8 boot while keeping the same key, orphaning the node's old (pre-2.8, MAC-derived) NodeNum. That leaves one physical node visible under two NodeNums sharing one key — which looks exactly like a duplicate-key collision but is benign. The scanner detects and suppresses this specific pattern: when a two-NodeNum group has exactly one NodeNum equal to `crc32(publicKey)` (the live new 2.8 identity) and the other has gone stale (a one-way handoff), it is treated as an upgrade renumber and **not** flagged as a security risk. A genuine collision where both nodes are still actively transmitting, or where neither NodeNum matches `crc32(publicKey)`, is still flagged — the suppression only covers the clear handoff case and errs toward keeping the warning when ambiguous.

**Detection frequency**:
- Initial scan: 5 minutes after server start
- Recurring scans: Every 24 hours (configurable via `DUPLICATE_KEY_SCAN_INTERVAL_HOURS` environment variable)
- Manual scans: Can be triggered via the `/api/nodes/scan-duplicate-keys` endpoint

**Configuration**:
```bash
# docker-compose.yml or environment configuration
environment:
  - DUPLICATE_KEY_SCAN_INTERVAL_HOURS=24  # Scan frequency in hours
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
1. Click the filter icon (tooltip: "Filter nodes") in the Nodes list header
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

**Authentication**: Requires `nodes:write` permission. The scan covers the Meshtastic sources you can write to, and looks for duplicates within each source, never across sources.

**Response**:
```json
{
  "success": true,
  "duplicatesFound": 2,
  "affectedNodes": [305419896, 2271560481],
  "totalNodesScanned": 156
}
```

**Use Cases**:
- Immediate scan after adding new nodes
- Verification after key rotation
- Troubleshooting security alerts

### Get Nodes with Security Issues

Retrieve all nodes currently flagged with security issues:

```bash
GET /api/security/issues?sourceId=<source id>
```

**Authentication**: Requires `security:read` and `nodes:read` on the source. The `sourceId` query parameter is required. Each node also carries `nodeKey` (`mt:<number>` or `mc:<key>`) and `protocol`. The response adds `counts`, `thresholds` and, for MeshCore, `packetLogEnabled`. MeshCore times are in seconds.

**Response**:
```json
{
  "total": 1,
  "lowEntropyCount": 1,
  "duplicateKeyCount": 0,
  "excessivePacketsCount": 0,
  "timeOffsetCount": 0,
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
  "topBroadcasters": []
}
```

## MeshCore Sources

The Security tab also works on MeshCore sources. It shows the sections below for the selected source.

### What MeshCore shows

- **Dead contacts**: contacts not heard for N days. Set N per source with "dead after N days". The default is 7 days for Meshtastic and 14 days for MeshCore.
- **Bulk delete**: you need `security:write` and `nodes:write` on the source. On a connected Companion, MeshMonitor removes the contacts from the radio and the database. On any other source, it removes them from the database only. A removed contact comes back on its next advert.
- **Path-hash collisions**: repeaters and room servers that share a path hash at the source's hash width. The tab shows counts for 2-byte and 3-byte hashes.
- **Advert signatures**: each contact shows Verified, Failed, or Not checked. Only Repeater and MQTT sources check signatures. Companion contacts always show Not checked.
- **Name reused under a new key**: a name that now appears under a different key. This view is for display only. MeshMonitor takes no action.
- **Own-key change**: a card appears when your own radio key changes. MeshMonitor sends one alert per change through the server-events notification preference. Click **Acknowledge** to clear the card.

The dead-contact list and the findings need `nodes:read` on the source, for both Meshtastic and MeshCore.

### Packet rates, clock offset, scanner, digest and export

These work for Meshtastic and MeshCore with the same thresholds:

| Check | Threshold | Notes |
|---|---|---|
| Excessive packets | more than **30 packets per hour** | Counted over the last hour at scan time. |
| Clock offset | more than **30 minutes** | Set `TIME_OFFSET_THRESHOLD_MINUTES` to change it. A positive value means the node is behind. |

**MeshCore packet rates need the packet log.** MeshCore counts distinct packets per key from the MeshCore packet monitor. Turn on **Packet Monitor** for the source, or the tab shows "Enable the MeshCore Packet Monitor to measure rates" and leaves rate flags as they are. MeshMonitor counts a packet once, however many observers or repeaters passed it on. It credits a packet to a key by:

- the full key, for adverts and anonymous requests;
- the one-byte sender hash, only when a single known contact on the source has that first byte (requests, responses and direct messages);
- never for group messages, ACKs and path packets, which carry no sender.

Your own radio is never flagged. Adverts are listed with the rate for information; advert cadence has its own check in Mesh Issues.

**MeshCore clock offset** comes from the newest advert (the time inside the advert) or direct message (the sender time) for each node. A node with no real-time clock stamps a default date in the past, so it is years off. The tab shows these as **Clock not set**. Other nodes drop adverts older than one they hold, so such a node is hard to hear until you set its time. Room server posts are ignored, because they replay when you log in. With the packet log off, the scan also uses the clock samples MeshMonitor stores from live adverts (the same samples the Device Health clock alert uses), so the flag still works.

**Scanner.** The 24-hour scan (plus one 5 minutes after start) now covers MeshCore sources, including MeshCore MQTT sources. It only reads the database and writes flags. It sends nothing and fires no events. **Run scan now** works on both. Flags stay until the next scan or until you clear them.

**Digest.** The daily Apprise digest covers MeshCore. Its sections are Excessive packets, Clock offset, Advert signature failed, Name reused under new key, and Own key changed (pending acknowledge). Collisions are not in the digest, because they are a configuration matter. Save digest settings per source: the Apprise URL, report type, format and "suppress when empty" belong to the source, and the enable switch and send time are global. If a source has no value for those four, MeshMonitor uses the global one. A source with no Apprise URL is skipped, not reported as a failure. Sources that use the global URL share **one combined digest** per day, with a heading for each source, instead of one message per source. A source with its own URL still sends its own digest.

**Send Now.** The **Send Now** button sends the digest for the source you view. The API call `POST /api/security/digest/send` needs a `sourceId` in the body and rejects a request without one (400), because it no longer sends for every source. It needs `security:write` and `nodes:read` on that source.

**Export.** Export as CSV or JSON from either protocol. The file lists every node with a flag, including nodes flagged only for spam or clock offset. CSV cells are quoted and escaped. The Meshtastic columns keep their order, and "Excessive Packets" and "Packets per Hour" come last. MeshCore has its own columns.

**Permissions.** `/issues`, `/export` and `/key-mismatches` need `nodes:read` on the source, as well as `security:read`. Scan and clear need `security:write` and `nodes:read` on the source.

### Send notification (a draft, never sent for you)

Rows for excessive packets and clock offset have a **Send notification** button, on Meshtastic and on MeshCore. It opens the node's direct message with a short English text in the box. You read it and press Send. MeshMonitor never sends it for you.

- The text is 75 bytes or less.
- MeshCore needs a **Companion** source and a **chat contact** target. Repeaters and Room Servers do not read DMs, so they get no button. The contact must be in the radio's table; if it is not, the button is disabled.
- You need `messages:write` on the source.
- When MeshMonitor knows no path to the node, a warning shows: "No known path: this DM will flood the mesh".

**Airtime cost.** Estimates for one click (US: SF7 / 62.5 kHz; EU: SF8 / 62.5 kHz), with an 89-byte packet at 3 hops:

| Case | US | EU |
|---|---|---|
| One DM on a known path (4 transmissions) | 1.43 s, plus the ACK 0.53 s | 3.74 s, plus the ACK 1.12 s |
| No path, so it floods (about 50 repeaters) | about 18 s across the mesh | about 46 s across the mesh |
| Worst case with no ACK (2 path retries and 1 flood) | about 22 s | about 57 s |

One click is one DM. It does not grow with node count, has no timer and never repeats by itself. It uses the normal message rate limit and the normal DM retry rules.

### What MeshCore does not have

- Low-entropy key detection and duplicate key detection (a MeshCore node is its key).
- Notification DMs to Repeaters or Room Servers.
- Per-sender spam counts for group messages (they carry no sender).

## Node name anti-spam

Some people put invite links in their node names, such as `MyNode t.me/spam_channel`. Those names then show up in the node list, map popups, messages and notifications. MeshMonitor can strip the link before it stores the name.

It is **off by default**. An admin turns it on in **Global Settings → Security → Node name anti-spam**.

### What it does

When a node name arrives, MeshMonitor replaces each link with a placeholder and keeps the rest of the name:

| Name sent by the node | Name MeshMonitor stores |
|---|---|
| `MyNode t.me/spam_channel` | `MyNode [spammer]` |
| `https://t.me/spam` | `[spammer]` |
| `Bob t . me/spam` | `Bob [spammer]` |

- It works for every source: Meshtastic over TCP, Meshtastic MQTT brokers and bridges, MeshCore companions and repeaters, and MeshCore MQTT.
- It covers the long name and the short name of Meshtastic nodes and the advert name of MeshCore nodes.
- It never changes your own node (the node each source is connected to).
- Matching ignores common tricks: full-width letters (`ｔ.ｍｅ`), hidden zero-width characters, and spaced or bracketed dots (`t . me`, `t[.]me`).
- Several links in a row become one placeholder, and extra spaces collapse.
- The result stays within the Meshtastic long-name size (24 bytes on firmware 2.8, up to 39 on older firmware). If the placeholder makes the name too long, MeshMonitor shortens the rest of the name, never the placeholder.

MeshMonitor does not keep the original name. If you turn the feature off, names stay cleaned until each node sends its name again (about every 3 hours on default Meshtastic firmware).

### Rules

- **Built-in rules** (on by default once the feature is on): any `http://` or `https://` link, plus `t.me/`, `telegram.me/`, `telegram.dog/`, `discord.gg/`, `wa.me/` and `chat.whatsapp.com/` links.
- **Extra hosts or patterns**, one per line:
  - A plain host such as `spam.example` matches `spam.example/anything`, with the same obfuscation handling as the built-ins.
  - Anything else is a regular expression in [RE2 syntax](https://github.com/google/re2/wiki/Syntax), matched without regard to case. RE2 cannot hang on a bad pattern. Each pattern can be at most 256 characters, and you can store up to 50. MeshMonitor refuses to save an invalid pattern.
- **Placeholder**: the text that replaces a link. The default is `[spammer]`, and it can be at most 24 bytes.

### Cleaning names already stored

New rules apply to names as they arrive. To clean names already in the database, click **Re-scan existing node names**. It runs the rules once over every stored Meshtastic and MeshCore node, on every source, and reports how many names changed. Older entries in a node's rename history are not changed.

The section also shows how many names it has rewritten since the server started.

### Airtime

None. The feature only changes what MeshMonitor stores. It sends no packets, arms no timers and never retries anything.

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
- Verify the scanner started: Look for "Starting security scanner"
- Check environment variable `DUPLICATE_KEY_SCAN_INTERVAL_HOURS`
- Restart the server to reinitialize the scanner

**Diagnostic Commands**:
```bash
# Get nodes with security issues (send your session cookie or API token)
curl "http://localhost:8080/api/security/issues?sourceId=<source id>"

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
- Security flags show to anyone who can see the node. The `/api/security/issues` list needs `security:read`

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

## Packet Authenticity (Protection Level)

The checks above are MeshMonitor's own. Firmware 2.8.0 adds a control on the node itself: a packet signature policy that decides whether the node accepts packets it cannot prove came from their sender. MeshMonitor sets it with the **Protection Level** picker (Compatible, Balanced or Strict) in the Security section of Device Configuration and of the Admin Commands tab. See [Protection Level](/features/device#protection-level-packet-authenticity) before you raise it: Strict drops most traffic from nodes older than 2.8.

What each level does depends on the firmware: 2.8.0 and 2.8.1 behave one way, later firmware another. The [Protection Level table](/features/device#protection-level-packet-authenticity) lists both. On later firmware, Balanced and Strict ignore an unsigned name or role change from a node that has signed before, and MeshMonitor shows an **Unsigned update ignored** notice when that happens.

## Two-Factor Authentication (MFA)

MeshMonitor supports TOTP-based two-factor authentication (MFA) for user accounts, adding an extra layer of security beyond username and password.

::: tip
Looking for passwordless sign-in? See [Passkeys](/features/passkeys). A passkey sign-in skips the TOTP code.
:::

### Overview

When MFA is enabled on an account, logging in requires both a password and a time-based one-time password (TOTP) generated by an authenticator app such as Google Authenticator, Authy, or any TOTP-compatible app.

### Setting Up MFA

1. Open the user menu (your username in the header) and choose **Two-Factor Auth**
2. Click **Enable Two-Factor Authentication**
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

- [API Documentation](/development/api-reference) - API reference and examples
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
