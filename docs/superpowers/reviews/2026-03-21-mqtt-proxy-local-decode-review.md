# Design Spec Review: MQTT Proxy Message Local Decoding (#2358)

**Spec**: `docs/superpowers/specs/2026-03-21-mqtt-proxy-local-decode-design.md`
**Reviewer**: Code Review Agent
**Date**: 2026-03-21
**Verdict**: Approve with minor issues

---

## What the spec does well

- Clean, minimal change scope -- single file, single else-if block
- Error handling strategy (log + forward) is consistent with the existing `toRadio.packet` pattern
- Correctly identifies `skipVirtualNodeBroadcast: true` to prevent echo loops
- Leverages existing decryption pipeline rather than reinventing

---

## Verification Results

### 1. Insertion point (~line 487) -- MINOR INACCURACY

The spec says to insert at ~line 487. The actual `else if` chain in `handleClientMessage` is:

- `toRadio.packet` block ends with `this.queueMessage(clientId, strippedPayload)` at **line 502**
- `else if (toRadio.wantConfigId)` starts at **line 503**

The new `else if (toRadio.mqttClientProxyMessage)` block should be inserted **between lines 502 and 503** (after the `queueMessage` call that ends the `toRadio.packet` branch, before `wantConfigId`). The spec's "~line 487" is off by about 15 lines but the description of "between the existing `toRadio.packet` handler and the generic forwarding else branch" is structurally correct.

**Severity**: Suggestion -- line numbers are approximate guidance, not critical.

### 2. ServiceEnvelope decode availability -- IMPORTANT

The spec says `meshtasticProtobufService` existing encode/decode utilities are used "as-is" with no modifications. However:

- `ServiceEnvelope` is **not** currently imported or used anywhere in `meshtasticProtobufService.ts` (grep returns zero hits)
- The protobuf definition exists in `protobufs/meshtastic/mqtt.proto` and is loadable via `getProtobufRoot().lookupType('meshtastic.ServiceEnvelope')`
- The implementation will need to **add a new decode method** (e.g., `decodeServiceEnvelope(data: Uint8Array)`) to `MeshtasticProtobufService`, or do an inline `lookupType` + `decode` in the VNS

The spec's "Files Modified" table lists only `virtualNodeServer.ts`. Either:
- (a) A helper method should be added to `meshtasticProtobufService.ts` (preferred, consistent with existing patterns), which means the files-modified table is incomplete, OR
- (b) The VNS code does inline `getProtobufRoot().lookupType('meshtastic.ServiceEnvelope').decode(data)`, which works but breaks the established abstraction

**Severity**: Important -- the spec should clarify which approach and update the files-modified table accordingly.

### 3. `viaMqtt` field on MeshPacket -- CONFIRMED VALID

The field `viaMqtt` is confirmed present on MeshPacket objects. It is used extensively in `meshtasticManager.ts` (e.g., line 3904: `viaMqtt: meshPacket.viaMqtt === true`). Setting `packet.viaMqtt = true` on the extracted packet is correct.

### 4. `processIncomingData` signature -- CONFIRMED VALID

```typescript
public async processIncomingData(data: Uint8Array, context?: ProcessingContext): Promise<void>
```

`ProcessingContext` includes `skipVirtualNodeBroadcast?: boolean` (line 37 of meshtasticManager.ts). The spec's usage `processIncomingData(fromRadioBytes, { skipVirtualNodeBroadcast: true })` is correct.

### 5. `mqttClientProxyMessage` currently unhandled -- CONFIRMED

Grep for `mqttClientProxyMessage` in `virtualNodeServer.ts` returns zero hits. The field is defined in `protobufLoader.ts` (line 102) as part of the ToRadio type. Currently, these messages fall through to the generic `else` branch at the bottom of the chain, which forwards them via `queueMessage` to the physical node. The spec correctly identifies this gap.

---

## Edge Cases the Spec Misses

### CRITICAL: Duplicate processing when radio echoes the packet back

When the VNS locally processes the MQTT proxy message AND forwards it to the radio, and the radio successfully publishes to MQTT and then receives the same packet back from the broker, `processIncomingData` will be called twice for the same MeshPacket (once from VNS local decode, once from the radio echo). The spec does not address whether existing deduplication logic (packet ID based, see line 3971 and 5057 in meshtasticManager.ts) will handle this. The implementer should verify that the dedup logic catches this case, or document why it is not a concern.

**Severity**: Important -- could cause duplicate messages in the UI/database.

### IMPORTANT: FromRadio wrapping requires encode+decode round-trip

The spec says "Wrap MeshPacket in FromRadio { packet }" then "Serialize and call processIncomingData(fromRadioBytes, ...)". The existing pattern in the `toRadio.packet` block uses `meshtasticProtobufService.createFromRadioWithPacket()` which handles the encode. The spec should reference this existing helper rather than implying manual construction, to stay consistent.

**Severity**: Suggestion -- implementer will likely discover this naturally.

### MINOR: No mention of the `from=0` fix pattern

The existing `toRadio.packet` handler has logic to fix `from=0` (Android client issue #626). MQTT proxy messages may similarly have packets with `from=0` in the ServiceEnvelope. The spec should note whether this fix applies or not (it likely does not, since MQTT messages originate from remote nodes, not the local client).

**Severity**: Suggestion -- worth a comment in the implementation.

---

## Summary of Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | Important | `ServiceEnvelope` decode not available in protobuf service; files-modified table incomplete |
| 2 | Important | Duplicate processing risk when radio echoes MQTT packet back |
| 3 | Suggestion | Line number ~487 is off; actual insertion point is ~line 502-503 |
| 4 | Suggestion | Should reference `createFromRadioWithPacket()` helper explicitly |
| 5 | Suggestion | Note whether `from=0` fix applies to MQTT proxy packets |

## Recommendation

Update the spec to address items 1 and 2 before implementation. The remaining suggestions can be handled during implementation.
