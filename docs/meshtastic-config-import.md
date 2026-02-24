# Meshtastic Configuration Import - Technical Documentation

## Overview

This document details the implementation of Meshtastic configuration import functionality, including critical discoveries about the Meshtastic protocol, transaction API, and channel URL encoding.

## Table of Contents

1. [The Transaction API Problem](#the-transaction-api-problem)
2. [Channel URL Encoding Structure](#channel-url-encoding-structure)
3. [Role Field Discovery](#role-field-discovery)
4. [Implementation Details](#implementation-details)
5. [Testing and Verification](#testing-and-verification)

---

## The Transaction API Problem

### Initial Issue

When importing Meshtastic configurations from URLs, channels were being sent to the device but **not persisting after device reboot**. This occurred specifically when:
- Importing channel settings
- Importing LoRa configuration (which triggers a device reboot)
- Both together

### Root Cause

The Meshtastic protocol requires a **transaction-based approach** when making configuration changes:

1. **Begin Transaction**: Call `begin_edit_settings` (AdminMessage field 64)
2. **Make Changes**: Send all channel configs, LoRa configs, etc.
3. **Commit Transaction**: Call `commit_edit_settings` (AdminMessage field 65)

**Critical Discovery**: We were only calling `commit_edit_settings` without first calling `begin_edit_settings`. The transaction API requires BOTH calls - omitting `begin_edit_settings` means changes are not properly batched and may be lost during device reboot.

### Solution Implementation

#### File: `src/server/meshtasticManager.ts`

Added `beginEditSettings()` method:

```typescript
async beginEditSettings(): Promise<void> {
  if (!this.isConnected || !this.transport) {
    throw new Error('Not connected to Meshtastic node');
  }

  try {
    logger.info('⚙️ Beginning edit settings transaction');
    const beginMsg = protobufService.createBeginEditSettingsMessage(new Uint8Array());
    const adminPacket = protobufService.createAdminPacket(
      beginMsg,
      this.localNodeInfo?.nodeNum || 0,
      this.localNodeInfo?.nodeNum
    );

    await this.transport.send(adminPacket);
    logger.info('⚙️ Sent begin_edit_settings admin message');
  } catch (error) {
    logger.error('❌ Error beginning edit settings:', error);
    throw error;
  }
}
```

Updated `commitEditSettings()` to add delay for flash write:

```typescript
async commitEditSettings(): Promise<void> {
  if (!this.isConnected || !this.transport) {
    throw new Error('Not connected to Meshtastic node');
  }

  try {
    logger.info('⚙️ Committing edit settings to persist configuration');
    const commitMsg = protobufService.createCommitEditSettingsMessage(new Uint8Array());
    const adminPacket = protobufService.createAdminPacket(
      commitMsg,
      this.localNodeInfo?.nodeNum || 0,
      this.localNodeInfo?.nodeNum
    );

    await this.transport.send(adminPacket);
    logger.info('⚙️ Sent commit_edit_settings admin message');

    // Wait for device to save to flash storage
    await new Promise(resolve => setTimeout(resolve, 2000));
  } catch (error) {
    logger.error('❌ Error committing edit settings:', error);
    throw error;
  }
}
```

#### File: `src/server/server.ts`

Updated import flow (lines 1077-1143):

```typescript
// 1. Begin edit settings transaction
try {
  logger.info(`🔄 Beginning edit settings transaction for import`);
  await meshtasticManager.beginEditSettings();
  logger.info(`✅ Edit settings transaction started`);
} catch (error) {
  logger.error(`❌ Failed to begin edit settings transaction:`, error);
  throw new Error('Failed to start configuration transaction');
}

// 2. Import all channels (lines 1089-1117)
// ... channel import code ...

// 3. Import LoRa config (lines 1120-1133)
// ... lora config import code ...

// 4. Commit all changes as single transaction
try {
  logger.info(`💾 Committing all configuration changes...`);
  await meshtasticManager.commitEditSettings();
  logger.info(`✅ Configuration changes committed successfully - device will reboot`);
} catch (error) {
  logger.error(`❌ Failed to commit configuration changes:`, error);
}
```

### Key Takeaways

- **Always use the transaction API** when making multiple configuration changes
- **Begin → Change → Commit** is the required sequence
- **Flash write delay**: Allow 2 seconds after commit for device to write to flash storage
- **LoRa config changes trigger reboot**: Transaction ensures all changes persist through reboot

---

## Channel URL Encoding Structure

### Protobuf Hierarchy

Understanding the Meshtastic URL encoding requires knowledge of the protobuf message structure:

```
ChannelSet (meshtastic/apponly.proto)
├── repeated ChannelSettings settings [field 1]
└── Config.LoRaConfig lora_config [field 2]

ChannelSettings (meshtastic/channel.proto)
├── uint32 channel_num [field 1] (deprecated)
├── bytes psk [field 2]
├── string name [field 3]
├── fixed32 id [field 4]
├── bool uplink_enabled [field 5]
├── bool downlink_enabled [field 6]
├── ModuleSettings module_settings [field 7]
└── bool mute [field 8]

ModuleSettings (meshtastic/channel.proto)
└── uint32 position_precision [field 1]
```

### URL Format

Meshtastic configuration URLs follow this format:

```
https://meshtastic.org/e/#<base64-encoded-ChannelSet-protobuf>
```

**Important**: The base64 encoding omits padding characters (`=`). When decoding, padding must be added back.

### Example URL Decoding

```typescript
// From channelUrlService.ts
decodeUrl(url: string): DecodedChannelSet | null {
  // Extract base64 part
  let base64Data = url.split('#')[1];

  // Add padding if needed
  const missingPadding = base64Data.length % 4;
  if (missingPadding) {
    base64Data += '='.repeat(4 - missingPadding);
  }

  // Decode from base64
  const binaryData = Buffer.from(base64Data, 'base64');

  // Decode using protobuf
  const ChannelSet = root.lookupType('meshtastic.ChannelSet');
  const channelSet = ChannelSet.decode(binaryData);
  // ...
}
```

---

## Role Field Discovery

### Critical Finding: Role is NOT Encoded in URLs

Through examination of the Meshtastic protobuf definitions, we discovered:

1. **ChannelSet** (used in URLs) contains `ChannelSettings` messages
2. **ChannelSettings** does NOT have a `role` field
3. The `role` field exists ONLY in the **Channel** message (meshtastic/channel.proto)
4. **Channel** messages are used for device-to-device communication, NOT URL encoding

### Protobuf Evidence

From `meshtastic/apponly.proto`:
```protobuf
message ChannelSet {
  repeated ChannelSettings settings = 1;  // No role field
  Config.LoRaConfig lora_config = 2;
}
```

From `meshtastic/channel.proto`:
```protobuf
message Channel {
  enum Role {
    DISABLED = 0;
    PRIMARY = 1;
    SECONDARY = 2;
  }

  int32 index = 1;
  ChannelSettings settings = 2;
  Role role = 3;  // Role is HERE, not in ChannelSettings
}

message ChannelSettings {
  // ... fields listed above ...
  // NO role field
}
```

### Implication: Role Must Be Defaulted

Since Meshtastic URLs **do not encode channel roles**, we must apply appropriate defaults when importing:

- **Channel 0**: PRIMARY (role = 1) - Sets the radio frequency
- **Channels 1-7**: SECONDARY (role = 2) - Used only for encryption/decryption

### Implementation

From `src/server/server.ts` (lines 1095-1109):

```typescript
for (let i = 0; i < decoded.channels.length; i++) {
  const channel = decoded.channels[i];

  // Determine role: if not specified, channel 0 is PRIMARY (1), others are SECONDARY (2)
  let role = channel.role;
  if (role === undefined) {
    role = i === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
  }

  // Write channel to device
  await meshtasticManager.setChannelConfig(i, {
    name: channel.name || '',
    psk: channel.psk === 'none' ? undefined : channel.psk,
    role: role,
    uplinkEnabled: channel.uplinkEnabled,
    downlinkEnabled: channel.downlinkEnabled,
    positionPrecision: channel.positionPrecision
  });
}
```

### PSK Shorthand Encoding

ChannelSettings also uses shorthand encoding for PSK values:

```typescript
// Encoding (from channelUrlService.ts)
if (ch.psk === 'none') {
  channelSettings.psk = Buffer.from([0]);
} else if (ch.psk === 'default') {
  channelSettings.psk = Buffer.from([1]);
} else if (ch.psk.startsWith('simple')) {
  const num = parseInt(ch.psk.replace('simple', ''));
  channelSettings.psk = Buffer.from([num + 1]);
}

// Decoding
const decoded = Buffer.from(ch.psk, 'base64');
if (decoded.length === 1) {
  const value = decoded[0];
  if (value === 0) {
    channel.psk = 'none';
  } else if (value === 1) {
    channel.psk = 'default';
  } else if (value >= 2 && value <= 10) {
    channel.psk = `simple${value - 1}`;
  }
}
```

---

## Implementation Details

### Frontend: ImportConfigModal Component

Location: `src/components/configuration/ImportConfigModal.tsx`

Key features:
- Decodes URL to preview channels and LoRa config
- Allows selective import of channels and LoRa config
- Handles device reboot detection
- Polls for configuration updates after import

#### Device Reconnection Flow

```typescript
const waitForDeviceReconnect = async (): Promise<void> => {
  const maxWaitTime = 60000; // 60 seconds
  const pollInterval = 2000; // 2 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const statusData = await apiService.getConnectionStatus();
      if (statusData.connected === true) {  // IMPORTANT: Check boolean, not string
        await apiService.refreshNodes();
        return;
      }
    } catch (err) {
      // Device still offline, continue waiting
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Device did not reconnect within 60 seconds');
};
```

**Critical Note**: Connection check must use `statusData.connected === true` (boolean), not `status === 'connected'` (string). The API returns a boolean `connected` field.

### Backend: Channel URL Service

Location: `src/server/services/channelUrlService.ts`

Provides:
- `decodeUrl(url: string)`: Decode Meshtastic URL to channel settings
- `encodeUrl(channels, loraConfig)`: Encode channel settings to Meshtastic URL

### Backend: API Endpoint

Location: `src/server/server.ts` (lines 1055-1158)

Endpoint: `POST /api/channels/import-config`

Flow:
1. Decode URL
2. Begin edit settings transaction
3. Import channels with role defaults
4. Import LoRa config (if present)
5. Commit transaction (triggers device save/reboot)
6. Return success with reboot flag

---

## Testing and Verification

### Test URL

```
https://meshtastic.org/e/#CgsSAQEoATAAOgIIDgohEhDES+sy+sEe2m5u5gZZZoI+GgVhZG1pbigAMAA6AggACjISIDE2cGZwWGdQbVFRODJ4Z1hvRlplQzFrYjBVcjR1U1VjGghnYXVudGxldCgAMAA6AAoWEgEBGgl0ZWxlbWV0cnkoATAAOgIIDhIeCAEQBBgAIAAoADUAAAAAOAFABUgBUB5YAGgByAYB
```

This URL contains:
- 4 channels (admin, gauntlet, telemetry, and one unnamed)
- LoRa configuration with specific modem preset and region

### Expected Behavior

After import with transaction API:
1. ✅ All 4 channels persist through device reboot
2. ✅ Channel 0 has PRIMARY role
3. ✅ Channels 1-3 have SECONDARY role
4. ✅ LoRa config is applied and persists
5. ✅ Device reboots and reconnects automatically

### Verification Steps

1. Import configuration via UI
2. Wait for device reboot (ImportConfigModal shows progress)
3. After reboot, verify channels in Configuration > Channels
4. Check channel roles (should be PRIMARY/SECONDARY, not DISABLED)
5. Check LoRa config in Configuration > LoRa

### Container Verification

To verify deployed code includes role defaulting:

```bash
# Check container is running
docker compose -f docker-compose.dev.yml ps

# Verify role defaulting code exists
docker compose -f docker-compose.dev.yml exec meshmonitor \
  grep -A 5 "Determine role" /app/dist/server/server.js
```

Expected output:
```javascript
// Determine role: if not specified, channel 0 is PRIMARY (1), others are SECONDARY (2)
let role = channel.role;
if (role === undefined) {
    role = i === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
}
```

---

## Related Files

- `src/server/meshtasticManager.ts` - Meshtastic device communication
  - Lines 3980-3999: `beginEditSettings()`
  - Lines 4001-4023: `commitEditSettings()`

- `src/server/server.ts` - Import endpoint
  - Lines 1055-1158: Import configuration endpoint
  - Lines 1077-1085: Begin transaction
  - Lines 1095-1109: Channel import with role defaulting
  - Lines 1135-1143: Commit transaction

- `src/server/services/channelUrlService.ts` - URL encoding/decoding
  - Lines 47-159: `decodeUrl()`
  - Lines 164-238: `encodeUrl()`

- `src/components/configuration/ImportConfigModal.tsx` - Frontend import UI
  - Lines 92-131: `handleImport()` - Main import flow
  - Lines 133-158: `waitForDeviceReconnect()` - Reboot detection
  - Lines 160-187: `pollForChannelUpdates()` - Config verification

- `src/components/RebootModal.tsx` - Reboot progress display
  - Lines 35-173: `waitForReboot()` - Reboot monitoring logic

- `protobufs/meshtastic/apponly.proto` - ChannelSet definition
- `protobufs/meshtastic/channel.proto` - Channel and ChannelSettings definitions
- `protobufs/meshtastic/admin.proto` - Admin message definitions (begin_edit_settings, commit_edit_settings)

---

## Key Lessons Learned

1. **Transaction API is mandatory** for reliable configuration persistence
2. **Role field is not in URLs** - must be defaulted during import
3. **Channel 0 must be PRIMARY** - it sets the radio frequency
4. **Flash write takes time** - allow 2 seconds after commit
5. **LoRa config triggers reboot** - transaction ensures all changes persist
6. **Connection status is boolean** - `connected === true`, not string comparison
7. **Base64 URLs omit padding** - must be added when decoding

---

## Future Considerations

### Potential Enhancements

1. **Selective Channel Import**: Allow user to choose which channels to import
2. **Role Override**: Allow user to manually set channel roles during import
3. **Conflict Resolution**: Handle cases where imported channels conflict with existing ones
4. **Validation**: Verify channel names, PSK lengths, etc. before import
5. **Progress Feedback**: More granular progress updates during import

### Known Limitations

1. **URL format changes**: If Meshtastic changes the ChannelSet protobuf structure, decoder needs updates
2. **Maximum channels**: Limited to 8 channels (0-7) as per Meshtastic spec
3. **Reboot timeout**: 60 second timeout may not be sufficient for slow devices
4. **No rollback**: If commit fails, partial changes may be applied

---

## Debugging Tips

### Enable Verbose Logging

Check import logs:
```bash
docker compose -f docker-compose.dev.yml logs --tail=0 --follow 2>&1 | \
  grep -E "Import|Commit|Channel|⚙️ Sending|💾"
```

Check reboot sequence:
```bash
docker compose -f docker-compose.dev.yml logs --tail=0 --follow 2>&1 | \
  grep -E "RebootModal|Poll attempt|hopLimit|Configuration updated"
```

### Common Issues

**Problem**: Channels show as DISABLED after import
- **Cause**: Role defaulting not applied
- **Solution**: Verify role defaulting code is deployed (see Container Verification above)

**Problem**: Channels lost after reboot
- **Cause**: Transaction API not used
- **Solution**: Verify `beginEditSettings()` is called before channel import

**Problem**: Device doesn't reconnect
- **Cause**: Connection check using wrong field
- **Solution**: Use `statusData.connected === true` not `status === 'connected'`

**Problem**: Import timeout
- **Cause**: Device slow to reboot or sync
- **Solution**: Increase timeout values in ImportConfigModal.tsx

---

## References

- Official Meshtastic Protobuf Definitions: https://github.com/meshtastic/protobufs/
- Meshtastic Admin API: https://github.com/meshtastic/protobufs/blob/master/meshtastic/admin.proto
- Channel Protocol: https://github.com/meshtastic/protobufs/blob/master/meshtastic/channel.proto
- App-Only Messages: https://github.com/meshtastic/protobufs/blob/master/meshtastic/apponly.proto
