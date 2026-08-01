/**
 * Admin packets must carry the local node's CONFIGURED hop limit, not a
 * hardcoded 3.
 *
 * The builder used to pin `hopLimit: 3` — the firmware default — so a user who
 * raised `lora.hop_limit` to reach a deep mesh still had every remote admin
 * command die 3 hops out with no indication why. Meshtastic Python resolves
 * this client-side (`mesh_interface.py` `_sendPacket` falls back to
 * `localConfig.lora.hop_limit` when the caller passes none); these tests pin
 * the same behavior on our side.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { DEFAULT_HOP_LIMIT, MAX_HOP_LIMIT } from './constants/meshtastic.js';

/** Decode a ToRadio admin packet back to its MeshPacket. */
function decodePacket(encoded: Uint8Array): any {
  const root = getProtobufRoot()!;
  const ToRadio = root.lookupType('meshtastic.ToRadio');
  return (ToRadio.decode(encoded) as any).packet;
}

describe('createAdminPacket hop limit', () => {
  const payload = new Uint8Array([1, 2, 3]);

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('uses the caller-supplied hop limit', () => {
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344, 7));
    expect(packet.hopLimit).toBe(7);
  });

  it('falls back to the firmware default when no hop limit is supplied', () => {
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344));
    expect(packet.hopLimit).toBe(DEFAULT_HOP_LIMIT);
  });

  it('falls back to the firmware default when config has not arrived (undefined)', () => {
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344, undefined));
    expect(packet.hopLimit).toBe(DEFAULT_HOP_LIMIT);
  });

  it('clamps above-protocol values to MAX_HOP_LIMIT', () => {
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344, 99));
    expect(packet.hopLimit).toBe(MAX_HOP_LIMIT);
  });

  it('passes an explicit 0 through rather than promoting it to the default', () => {
    // Proto3 omits a zero hopLimit, so it decodes back as null/undefined — the
    // assertion is that it was NOT silently rewritten to 3. Firmware itself
    // rewrites an inbound want_ack packet at hop_limit 0 to the node's own
    // configured value, so this is safe on the wire either way.
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344, 0));
    expect(packet.hopLimit ?? 0).toBe(0);
  });

  it('applies the same resolution to createAdminPacketWithId', () => {
    const { data, packetId } = protobufService.createAdminPacketWithId(payload, 0xaabbccdd, 0x11223344, 5);
    expect(packetId).toBeGreaterThan(0);
    expect(decodePacket(data).hopLimit).toBe(5);
  });

  it('leaves the rest of the admin packet shape untouched', () => {
    const packet = decodePacket(protobufService.createAdminPacket(payload, 0xaabbccdd, 0x11223344, 6));
    expect(packet.to).toBe(0xaabbccdd);
    expect(packet.from).toBe(0x11223344);
    expect(packet.wantAck).toBe(true);
    expect(packet.priority).toBe(70);
    expect(packet.pkiEncrypted).toBe(true);
    expect(packet.decoded.portnum).toBe(6); // ADMIN_APP
    expect(packet.decoded.wantResponse).toBe(true);
  });
});
