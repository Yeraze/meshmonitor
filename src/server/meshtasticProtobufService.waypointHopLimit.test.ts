/**
 * createWaypointMessage hop limit (#5482) — pinned at the wire.
 *
 * The hardcoded `hopLimit: 3` is gone: the caller passes the resolved value.
 * A DM waypoint at hop 0 must drop `want_ack`, since the firmware rewrites
 * hop 0 on a want_ack packet to the node default (#5121). Broadcasts never
 * ask for an ACK.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from './meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

function decodePacket(data: Uint8Array): { hopLimit: number; wantAck: boolean } {
  const ToRadio = getProtobufRoot()!.lookupType('meshtastic.ToRadio');
  const decoded = ToRadio.decode(data) as unknown as { packet: Record<string, unknown> };
  return {
    // proto3 omits zero scalars on the wire: absent reads back as 0.
    hopLimit: (decoded.packet.hopLimit as number | undefined) ?? 0,
    wantAck: Boolean(decoded.packet.wantAck),
  };
}

const WP = { id: 42, latitude: 30, longitude: -90, expire: 0, name: 'Port' };

describe('createWaypointMessage hop limit (#5482)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('puts the given hop limit on a broadcast, with no ACK request', () => {
    const { data } = meshtasticProtobufService.createWaypointMessage(WP, { hopLimit: 5 });
    expect(decodePacket(data)).toEqual({ hopLimit: 5, wantAck: false });
  });

  it('sends a zero-hop broadcast at hop 0', () => {
    const { data } = meshtasticProtobufService.createWaypointMessage(WP, { hopLimit: 0 });
    expect(decodePacket(data)).toEqual({ hopLimit: 0, wantAck: false });
  });

  it('asks for an ACK on a DM with a non-zero hop limit', () => {
    const { data } = meshtasticProtobufService.createWaypointMessage(WP, { destination: 0x1234, hopLimit: 2 });
    expect(decodePacket(data)).toEqual({ hopLimit: 2, wantAck: true });
  });

  it('drops want_ack on a zero-hop DM so the firmware keeps hop 0', () => {
    const { data } = meshtasticProtobufService.createWaypointMessage(WP, { destination: 0x1234, hopLimit: 0 });
    expect(decodePacket(data)).toEqual({ hopLimit: 0, wantAck: false });
  });

  it('no longer hardcodes 3 when no hop limit is given', () => {
    const { data } = meshtasticProtobufService.createWaypointMessage(WP);
    expect(decodePacket(data).hopLimit).toBe(0);
  });
});
