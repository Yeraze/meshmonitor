# MQTT Proxy Message Local Decoding — Design Spec

**Issue:** #2358
**Date:** 2026-03-21
**Status:** Approved

## Overview

MeshMonitor's Virtual Node Server currently forwards `ToRadio.mqttClientProxyMessage` payloads directly to the physical radio without local processing. If the radio doesn't have the channel configured, the message is silently dropped and never appears in the UI. This fix intercepts these messages, extracts the inner `MeshPacket` from the `ServiceEnvelope`, and feeds it through the existing decryption/processing pipeline via the Server Channel Database.

## Design

### Change Location

Primary file: `src/server/virtualNodeServer.ts`, in the `handleClientMessage` function (~line 502).

Add an `else if (toRadio.mqttClientProxyMessage)` block between the existing `toRadio.packet` handler and the generic forwarding else branch.

A helper method for decoding `ServiceEnvelope` will be added to `meshtasticProtobufService.ts` using `getProtobufRoot().lookupType('meshtastic.ServiceEnvelope')` (the mqtt.proto definitions are already loaded).

### Processing Flow

```
MQTT Proxy Client → ToRadio { mqttClientProxyMessage }
    ↓
1. Decode mqttClientProxyMessage.data as ServiceEnvelope protobuf
2. Validate: ServiceEnvelope.packet exists
3. Set packet.viaMqtt = true
4. Wrap MeshPacket in FromRadio using existing `createFromRadioWithPacket()` helper
5. Call processIncomingData(fromRadioBytes, { skipVirtualNodeBroadcast: true })
6. Forward original ToRadio to physical radio via queueMessage()
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Forward to radio after local processing | Yes | Matches existing `toRadio.packet` pattern; radio may handle channels it knows |
| Mark packet as MQTT-sourced | `viaMqtt = true` | Consistent with how MQTT packets are flagged in the UI |
| Decryption strategy | Use existing pipeline | `channelDecryptionService.tryDecrypt()` already handles encrypted packets; no channel_id hint needed |
| Error handling | Log warning, forward only | If ServiceEnvelope decode fails, don't block the message from reaching the radio |

### Error Handling

- If `mqttClientProxyMessage.data` is empty or not present: log warning, forward to radio only
- If `ServiceEnvelope` decode throws: log warning, forward to radio only
- If `ServiceEnvelope.packet` is null/undefined: log warning, forward to radio only
- In all error cases, the original `ToRadio` is still forwarded to the physical node

### Duplicate Processing Prevention

When the VNS processes the packet locally AND forwards it to the radio, the radio may echo the same packet back. Existing dedup logic in `processMeshPacket` handles this — text messages are deduplicated by `message.id` at the database insert level (duplicate inserts log "Skipped duplicate message" and return early). Other packet types (telemetry, position) are idempotent upserts.

### What Doesn't Change

- `processIncomingData` — no modifications needed
- `processMeshPacket` — server-side decryption already works for encrypted packets
- `channelDecryptionService` — iterates channels by sort order as usual

## Files Modified

| File | Change |
|------|--------|
| `src/server/virtualNodeServer.ts` | Add `else if (toRadio.mqttClientProxyMessage)` block in `handleClientMessage` |
| `src/server/meshtasticProtobufService.ts` | Add `decodeServiceEnvelope(data: Uint8Array)` method |

## Testing

- Unit test: mock `meshtasticProtobufService` to decode a ServiceEnvelope, verify `processIncomingData` is called with correct FromRadio bytes and `{ skipVirtualNodeBroadcast: true }`
- Unit test: verify `viaMqtt = true` is set on the extracted MeshPacket
- Unit test: verify `queueMessage` is still called (forwarding to radio)
- Unit test: verify graceful handling when ServiceEnvelope decode fails (warning logged, message still forwarded)
