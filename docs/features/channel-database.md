# Channel Database

The Channel Database feature allows MeshMonitor to store additional channel configurations beyond your device's 8 channel slots. These stored channels can be used for **server-side packet decryption**, enabling you to monitor encrypted traffic from channels you're not actively participating in.

![Channel Database](/images/features/channel-database.png)

## Overview

Meshtastic devices are limited to 8 channel slots, but mesh networks often have many more channels in use. The Channel Database solves this limitation by:

1. **Storing unlimited channel configurations** - Save channel name and PSK combinations in MeshMonitor's database
2. **Server-side decryption** - Automatically decrypt incoming encrypted packets using stored channel keys
3. **Read-only access** - View decrypted message content without transmit capability
4. **Retroactive processing** - When adding a new channel, MeshMonitor processes historical encrypted packets

::: warning Read-Only Feature
The Channel Database provides **read-only** decryption capability. You can view decrypted content but cannot send messages on database-stored channels. To transmit, you must have the channel configured on your connected Meshtastic device.
:::

## Accessing the Channel Database

The Channel Database is located in the **Configuration** tab under **Channel Database**.

### Permissions Required

- **Admin users** can manage all database channels (add, edit, delete)
- **Non-admin users** need explicit permissions to view decrypted content from specific channels

## Adding a Channel

1. Navigate to **Configuration** > **Channel Database**
2. Click **Add Channel**
3. Enter the channel details:
   - **Name** - A descriptive name for the channel
   - **PSK** - The Pre-Shared Key (Base64 encoded)
   - **Description** (optional) - Notes about the channel's purpose
4. Click **Save**

::: tip PSK Format
Enter the PSK in Base64 format, the same format used by Meshtastic. You can find channel PSKs in your device's channel configuration or exported settings.
:::

## Channel Priority and Ordering

Channels in the database are tried in **sort order** during decryption. The first channel that successfully decrypts a packet wins. You can control the order using drag-and-drop:

1. Navigate to **Configuration** > **Channel Database**
2. Drag channels using the handle on the left side of each channel card
3. Drop to reorder - channels higher in the list are tried first
4. The new order is saved automatically

::: tip Decryption Priority
If multiple channels could potentially decrypt the same packet (e.g., same PSK with different names), only the first matching channel in sort order will be credited with the decryption.
:::

## Importing and Exporting Channels

The Channel Database supports bulk import and export via JSON files. This is useful for:

- **Backup and restore** — save your channel configurations before reinstalling
- **Sharing** — distribute a regional channel list to other operators
- **Migration** — copy channels between MeshMonitor instances
- **Bootstrapping** — pre-populate a fresh install with a known set of channels

### Exporting Channels

1. Navigate to **Configuration** > **Channel Database**
2. Click the **Export** button
3. A file named `meshmonitor-channels-<timestamp>.json` is downloaded to your browser's default download location

The export contains every channel currently in the database, in sort order, with full PSKs.

::: danger Exports Contain Secrets
Exported JSON files contain your raw PSKs in Base64 form. Treat them like passwords — store them encrypted, do not commit them to public repositories, and avoid sharing them in untrusted channels.
:::

### Importing Channels

1. Navigate to **Configuration** > **Channel Database**
2. Click the **Import** button
3. Select a `.json` file with one or more channel entries
4. Review the preview and click **Import**

Each entry is added as a **new** channel — import never overwrites or merges with existing entries. If you want to replace your channel list, delete the old entries first.

### JSON File Format

The import/export format is a JSON array of channel objects (a single object is also accepted on import for convenience):

```json
[
  {
    "name": "LongFast",
    "psk": "AQ==",
    "description": "Default Meshtastic primary channel",
    "isEnabled": true,
    "enforceNameValidation": false
  },
  {
    "name": "Regional Emergency",
    "psk": "1PG7OiApBgr0G/+rz05pAVHc1xPJD9C2c8RNJYBoqjE=",
    "description": "Regional emergency coordination",
    "isEnabled": true,
    "enforceNameValidation": true
  }
]
```

#### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Human-readable channel name. Used for display and (when `enforceNameValidation` is true) for channel-hash matching. |
| `psk` | string | **Yes** | Pre-Shared Key as a Base64-encoded string. Accepted lengths when decoded: **1 byte** (Meshtastic shorthand: `AQ==` = default key, `Ag==`–`Cg==` = simple1–simple9), **16 bytes** (AES-128), or **32 bytes** (AES-256). PSK value `0` (no encryption) is rejected. |
| `description` | string | No | Free-form notes. Defaults to empty string. |
| `isEnabled` | boolean | No | When `true`, MeshMonitor uses this channel for decryption. Defaults to `true` on import. |
| `enforceNameValidation` | boolean | No | When `true`, only attempt decryption if the packet's channel hash matches this channel's name. Useful when multiple channels share the same PSK. Defaults to `false`. |

#### Notes

- **Sort order is not preserved on import.** New channels are appended to the end of the existing list. You can reorder them after import using drag-and-drop.
- **`pskLength` is derived automatically** from the decoded PSK and does not need to be specified.
- **Duplicate detection is not performed on import.** If you import the same file twice you will get duplicate entries.
- **The `id`, `decryptedPacketCount`, `lastDecryptedAt`, `createdBy`, `createdAt`, and `updatedAt` fields** present on exports are ignored on import — the server assigns fresh values.

#### Example: Minimal Import

If you only have channel names and PSKs, this is the smallest valid file:

```json
[
  { "name": "MediumFast", "psk": "AQ==" },
  { "name": "Mesh-NYC", "psk": "1PG7OiApBgr0G/+rz05pAVHc1xPJD9C2c8RNJYBoqjE=" }
]
```

## How Server-Side Decryption Works

When MeshMonitor receives an encrypted packet:

1. The packet is first processed by your connected Meshtastic node
2. If your node can decrypt it (channel is in device slots), you see the decrypted content
3. If your node cannot decrypt it, MeshMonitor tries each enabled Channel Database entry **in sort order**
4. On successful decryption, the packet content is decoded and displayed
5. The Packet Monitor shows a special indicator for server-decrypted packets

### Decryption Indicators in Packet Monitor

| Icon | Meaning |
|------|---------|
| Green unlock | Decrypted by your Meshtastic node |
| Blue key | Decrypted by MeshMonitor (Channel Database) |
| Red lock | Encrypted (no matching key found) |

## Retroactive Processing

When you add a new channel to the database, MeshMonitor automatically processes historical encrypted packets:

1. Scans the packet log for encrypted packets
2. Attempts decryption with the new channel's PSK
3. Updates successfully decrypted packets with their content
4. Shows progress during processing

This means you can add a channel key and immediately see historical messages that were previously unreadable.

## Security Considerations

::: danger Protect Your Channel Keys
Channel PSKs are stored in MeshMonitor's database. Ensure your MeshMonitor instance is properly secured:
- Use strong authentication
- Enable HTTPS in production
- Restrict admin access
- Regular backups include channel keys
:::

### Permission Model

The Channel Database uses a permission system to control access:

- **Admins** have full access to all database channels
- **Non-admin users** must be granted explicit read permission per channel
- Permissions are managed in the Admin tab

## Managing Channels

### Enabling/Disabling Channels

Toggle channels on or off without deleting them. Disabled channels are not used for decryption but remain in the database.

### Enforce Name Validation

When enabled, this option ensures that a channel will only decrypt packets that have a matching channel hash. This is useful when:

- Multiple channels share the same PSK (e.g., default keys)
- You want to ensure packets are attributed to the correct channel name
- You're monitoring networks where channel naming conventions matter

::: warning
If the sending device doesn't include channel hash information in packets, enabling this option may prevent decryption even with a valid PSK.
:::

### Editing Channels

Update the name, PSK, or description of existing channels. Changed PSKs will affect future decryption and can trigger retroactive processing.

### Deleting Channels

Remove channels you no longer need. This does not affect already-decrypted packets in the log.

### Channel Statistics

Each channel entry shows:
- **Decrypted packet count** - How many packets have been decrypted using this channel
- **Last decrypted** - Timestamp of the most recent decryption
- **Status** - Enabled or disabled

## Use Cases

### Monitoring Multiple Communities

If your mesh spans multiple communities with different channels, store all channel keys to monitor traffic across the entire network.

### Security Auditing

Network administrators can use the Channel Database to audit traffic patterns across all channels without configuring each one on their device.

### Historical Analysis

Add channel keys later to decrypt historical traffic that was captured but not readable at the time.

### Channel Key Recovery

If you have backup channel configurations, import them into the Channel Database to restore monitoring capability.

## API Access

The Channel Database is accessible via the V1 API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/channel-database` | List all channels (filtered by permission) |
| GET | `/api/v1/channel-database/:id` | Get specific channel |
| POST | `/api/v1/channel-database` | Create new channel (admin only) |
| PUT | `/api/v1/channel-database/:id` | Update channel (admin only) |
| DELETE | `/api/v1/channel-database/:id` | Delete channel (admin only) |

## Limitations

- **No transmit capability** - Database channels are read-only
- **Requires encrypted packets to be captured** - Your node must receive the packets first
- **AES decryption only** - Standard Meshtastic encryption (AES-128-CTR or AES-256-CTR)
- **Performance** - Very large numbers of channels may impact packet processing speed

## Troubleshooting

### Packets Not Decrypting

1. Verify the PSK is correct and in Base64 format
2. Check that the channel is enabled in the database
3. Ensure your node is receiving the encrypted packets
4. Verify you have permission to view the channel

### Missing Historical Packets

Retroactive processing only works on packets stored in the packet log. If packet logging was disabled or packets were purged, they cannot be recovered.

### Performance Issues

If packet processing becomes slow:
1. Disable unused channels
2. Reduce the number of enabled database channels
3. Consider purging old packet log entries
