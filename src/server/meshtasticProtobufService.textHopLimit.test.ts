/**
 * createTextMessage hop-limit override (#5121) — pinned at the wire.
 *
 * Firmware `Router.cpp` rewrites `hop_limit == 0` on a `want_ack` packet from
 * the phone API to the node's default ("the client app has no preference").
 * So a zero-hop override is only real if the packet also drops `want_ack`;
 * otherwise it silently goes out at full reach. These tests decode the actual
 * ToRadio bytes rather than trusting the builder's intermediate object.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

function decodePacket(data: Uint8Array): { hopLimit: number; wantAck: boolean; hasHopLimit: boolean } {
  const ToRadio = getProtobufRoot()!.lookupType('meshtastic.ToRadio');
  const decoded = ToRadio.decode(data) as unknown as { packet: Record<string, unknown> };
  const packet = decoded.packet;
  return {
    // proto3 omits zero scalars on the wire: absent reads back as 0.
    hopLimit: (packet.hopLimit as number | undefined) ?? 0,
    wantAck: Boolean(packet.wantAck),
    hasHopLimit: Object.prototype.hasOwnProperty.call(packet, 'hopLimit') && packet.hopLimit !== 0,
  };
}

describe('createTextMessage hop-limit override (#5121)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('leaves hop_limit unset and asks for an ACK when there is no override', () => {
    const { data } = meshtasticProtobufService.createTextMessage('hi', undefined, 0);
    const pkt = decodePacket(data);
    expect(pkt.hasHopLimit).toBe(false);
    expect(pkt.wantAck).toBe(true);
  });

  it('writes a nonzero override onto the packet and keeps the ACK request', () => {
    const { data } = meshtasticProtobufService.createTextMessage('hi', 0x1234, 0, undefined, undefined, false, 2);
    const pkt = decodePacket(data);
    expect(pkt.hopLimit).toBe(2);
    expect(pkt.wantAck).toBe(true);
  });

  it('drops want_ack for a zero-hop send, or the firmware would restore full reach', () => {
    const { data } = meshtasticProtobufService.createTextMessage('hi', undefined, 0, undefined, undefined, false, 0);
    const pkt = decodePacket(data);
    expect(pkt.hopLimit).toBe(0);
    expect(pkt.wantAck).toBe(false);
  });

  it('drops want_ack for a zero-hop DM too', () => {
    const { data } = meshtasticProtobufService.createTextMessage('hi', 0x1234, 0, undefined, undefined, true, 0);
    expect(decodePacket(data).wantAck).toBe(false);
  });
});
