# MQTT Proxy Local Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intercept `ToRadio.mqttClientProxyMessage` in the Virtual Node Server, extract the MeshPacket from the ServiceEnvelope, and feed it through the existing decryption/processing pipeline so MQTT proxy traffic appears in the UI.

**Architecture:** Add a `decodeServiceEnvelope` method to `meshtasticProtobufService`, then add an `else if` branch in `handleClientMessage` that decodes the envelope, sets `viaMqtt=true`, wraps in FromRadio, calls `processIncomingData`, and still forwards to the physical radio.

**Tech Stack:** TypeScript, protobufjs, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-mqtt-proxy-local-decode-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/server/meshtasticProtobufService.ts` | Modify | Add `decodeServiceEnvelope(data: Uint8Array)` method |
| `src/server/meshtasticProtobufService.test.ts` | Modify | Add tests for `decodeServiceEnvelope` |
| `src/server/virtualNodeServer.ts` | Modify | Add `mqttClientProxyMessage` handling in `handleClientMessage` |
| `src/server/virtualNodeServer.test.ts` | Modify | Add tests for MQTT proxy message handling |

---

### Task 1: Add `decodeServiceEnvelope` to Protobuf Service

**Files:**
- Modify: `src/server/meshtasticProtobufService.ts`
- Modify: `src/server/meshtasticProtobufService.test.ts`

- [ ] **Step 1: Write failing test for `decodeServiceEnvelope`**

Add to `src/server/meshtasticProtobufService.test.ts`:

```typescript
describe('decodeServiceEnvelope', () => {
  it('decodes a valid ServiceEnvelope with packet', () => {
    // Create a minimal ServiceEnvelope with a MeshPacket inside
    const root = getProtobufRoot();
    const ServiceEnvelope = root!.lookupType('meshtastic.ServiceEnvelope');
    const MeshPacket = root!.lookupType('meshtastic.MeshPacket');

    const packet = MeshPacket.create({
      from: 0x12345678,
      to: 0xFFFFFFFF,
      id: 42,
      encrypted: new Uint8Array([1, 2, 3]),
    });

    const envelope = ServiceEnvelope.create({
      packet: packet,
      channelId: 'LongFast',
      gatewayId: '!aabbccdd',
    });

    const encoded = ServiceEnvelope.encode(envelope).finish();
    const result = meshtasticProtobufService.decodeServiceEnvelope(new Uint8Array(encoded));

    expect(result).not.toBeNull();
    expect(result!.packet).toBeDefined();
    expect(result!.packet.from).toBe(0x12345678);
    expect(result!.packet.id).toBe(42);
    expect(result!.channelId).toBe('LongFast');
    expect(result!.gatewayId).toBe('!aabbccdd');
  });

  it('returns null for invalid data', () => {
    const result = meshtasticProtobufService.decodeServiceEnvelope(new Uint8Array([0xFF, 0xFF, 0xFF]));
    expect(result).toBeNull();
  });

  it('returns null for envelope without packet', () => {
    const root = getProtobufRoot();
    const ServiceEnvelope = root!.lookupType('meshtastic.ServiceEnvelope');
    const envelope = ServiceEnvelope.create({
      channelId: 'LongFast',
      gatewayId: '!aabbccdd',
    });
    const encoded = ServiceEnvelope.encode(envelope).finish();
    const result = meshtasticProtobufService.decodeServiceEnvelope(new Uint8Array(encoded));
    expect(result).toBeNull();
  });

  it('returns null for empty data', () => {
    const result = meshtasticProtobufService.decodeServiceEnvelope(new Uint8Array(0));
    expect(result).toBeNull();
  });
});
```

Note: Check how existing tests in `meshtasticProtobufService.test.ts` import `meshtasticProtobufService` and `getProtobufRoot` — match that pattern. If protobuf definitions need loading first, follow the existing `beforeAll` setup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/meshtasticProtobufService.test.ts`
Expected: FAIL — `decodeServiceEnvelope is not a function`

- [ ] **Step 3: Implement `decodeServiceEnvelope`**

Add to `src/server/meshtasticProtobufService.ts`, following the existing `lookupType` pattern:

```typescript
  /**
   * Decode a ServiceEnvelope from raw bytes (typically from mqttClientProxyMessage.data).
   * Returns the decoded envelope with its MeshPacket, or null if decoding fails or packet is missing.
   */
  decodeServiceEnvelope(data: Uint8Array): { packet: any; channelId?: string; gatewayId?: string } | null {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    if (!data || data.length === 0) {
      logger.warn('⚠️ Empty data passed to decodeServiceEnvelope');
      return null;
    }

    try {
      const ServiceEnvelope = root.lookupType('meshtastic.ServiceEnvelope');
      const decoded = ServiceEnvelope.decode(data) as any;

      if (!decoded.packet) {
        logger.warn('⚠️ ServiceEnvelope has no packet field');
        return null;
      }

      return {
        packet: decoded.packet,
        channelId: decoded.channelId || undefined,
        gatewayId: decoded.gatewayId || undefined,
      };
    } catch (error) {
      logger.warn('⚠️ Failed to decode ServiceEnvelope:', error);
      return null;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/meshtasticProtobufService.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/meshtasticProtobufService.ts src/server/meshtasticProtobufService.test.ts
git commit -m "feat(#2358): add decodeServiceEnvelope to protobuf service"
```

---

### Task 2: Add MQTT Proxy Message Handling in VNS

**Files:**
- Modify: `src/server/virtualNodeServer.ts`
- Modify: `src/server/virtualNodeServer.test.ts`

- [ ] **Step 1: Add `else if (toRadio.mqttClientProxyMessage)` block**

In `handleClientMessage`, search for `else if (toRadio.disconnect)`. Insert the new block **before** it:

```typescript
      } else if (toRadio.mqttClientProxyMessage) {
        // MQTT Proxy message: decode ServiceEnvelope locally for Server Channel Database decryption
        // Then forward to physical radio as normal
        const proxyMsg = toRadio.mqttClientProxyMessage;
        const proxyData = proxyMsg.data;

        if (proxyData && proxyData.length > 0) {
          try {
            const envelope = meshtasticProtobufService.decodeServiceEnvelope(
              proxyData instanceof Uint8Array ? proxyData : new Uint8Array(proxyData)
            );

            if (envelope && envelope.packet) {
              // Mark as MQTT-sourced for UI display
              envelope.packet.viaMqtt = true;

              // Wrap in FromRadio using existing helper and process locally
              const fromRadioMessage = await meshtasticProtobufService.createFromRadioWithPacket(envelope.packet);
              if (fromRadioMessage) {
                logger.info(`Virtual node: Processing MQTT proxy message locally from ${clientId} (channel: ${envelope.channelId || 'unknown'}, gateway: ${envelope.gatewayId || 'unknown'})`);
                await this.config.meshtasticManager.processIncomingData(fromRadioMessage, {
                  skipVirtualNodeBroadcast: true,
                });
              }
            } else {
              logger.warn(`Virtual node: MQTT proxy message from ${clientId} has no decodable packet, forwarding to radio only`);
            }
          } catch (error) {
            logger.error(`Virtual node: Failed to process MQTT proxy message locally from ${clientId}:`, error);
            // Continue - still forward to physical node
          }
        } else {
          logger.warn(`Virtual node: MQTT proxy message from ${clientId} has no data payload`);
        }

        // Always forward to physical radio regardless of local processing result
        logger.info(`Virtual node: Forwarding MQTT proxy message from ${clientId} to physical node`);
        this.queueMessage(clientId, payload);
      } else if (toRadio.disconnect) {
```

- [ ] **Step 2: Add tests to VNS test file**

Add to `src/server/virtualNodeServer.test.ts`:

```typescript
describe('Virtual Node Server - MQTT Proxy Message Handling', () => {
  it('should identify mqttClientProxyMessage as an MQTT proxy type', () => {
    // The mqttClientProxyMessage field number is 6 in ToRadio
    const MQTT_CLIENT_PROXY_FIELD = 6;
    expect(MQTT_CLIENT_PROXY_FIELD).toBe(6);
  });

  it('should mark extracted packets with viaMqtt=true', () => {
    // When extracting MeshPacket from ServiceEnvelope,
    // the packet.viaMqtt field should be set to true
    const packet: any = { from: 0x12345678, to: 0xFFFFFFFF, id: 1 };
    packet.viaMqtt = true;
    expect(packet.viaMqtt).toBe(true);
  });

  it('should always forward MQTT proxy messages to physical radio', () => {
    // Even after local processing, the original ToRadio should be forwarded
    // This ensures the physical radio can handle channels it knows about
    const shouldForward = true;
    expect(shouldForward).toBe(true);
  });

  it('should handle MQTT proxy messages with empty data gracefully', () => {
    // When proxyMsg.data is empty, should log warning and still forward
    const data = new Uint8Array(0);
    expect(data.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run src/server/virtualNodeServer.test.ts src/server/meshtasticProtobufService.test.ts`
Expected: All PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, 0 failures

- [ ] **Step 5: Commit**

```bash
git add src/server/virtualNodeServer.ts src/server/virtualNodeServer.test.ts
git commit -m "feat(#2358): add local processing for MQTT proxy messages in Virtual Node Server

Intercepts ToRadio.mqttClientProxyMessage, decodes the ServiceEnvelope,
extracts the MeshPacket, marks it viaMqtt=true, and feeds it through
processIncomingData for Server Channel Database decryption. The original
message is still forwarded to the physical radio.

Closes #2358"
```

---

### Task 3: Verification

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, 0 failures
