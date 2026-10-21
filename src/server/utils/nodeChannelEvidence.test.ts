/**
 * #5923: a node must only be recorded on a channel when our radio decrypted
 * its own traffic with that channel's key.
 */
import { describe, it, expect } from 'vitest';
import { channelIndexFromPacket, isSpoofedZeroHopPacket } from './nodeChannelEvidence.js';

const FROM = 0x1234abcd;
const RX_TIME = 1_760_000_000;

/** Firmware `PhoneAPI::makeReplayPacketId`, copied so the test is independent of replayGuard. */
function replayId(fromNum: number, rxTimeSec: number, kind: number): number {
  let h = fromNum >>> 0;
  h = (Math.imul(h, 2654435761) + (rxTimeSec >>> 0)) >>> 0;
  h = (Math.imul(h, 2654435761) + kind) >>> 0;
  return h === 0 ? 1 : h;
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    from: FROM,
    id: 777,
    channel: 2,
    rxTime: RX_TIME,
    hopStart: 3,
    hopLimit: 2,
    relayNode: 0x55,
    viaMqtt: false,
    pkiEncrypted: false,
    ...overrides,
  };
}

const node = { decryptedBy: 'node' as const };

describe('channelIndexFromPacket (#5923)', () => {
  it('returns the index for a channel packet our radio decoded', () => {
    expect(channelIndexFromPacket(packet(), node)).toBe(2);
  });

  it('returns 0 for a genuine slot-0 packet', () => {
    expect(channelIndexFromPacket(packet({ channel: 0 }), node)).toBe(0);
  });

  it('ignores server-decrypted and undecrypted packets', () => {
    expect(channelIndexFromPacket(packet(), { decryptedBy: 'server' })).toBeUndefined();
    expect(channelIndexFromPacket(packet(), { decryptedBy: null })).toBeUndefined();
  });

  it('ignores a missing channel', () => {
    expect(channelIndexFromPacket(packet({ channel: undefined }), node)).toBeUndefined();
    expect(channelIndexFromPacket(packet({ channel: null }), node)).toBeUndefined();
  });

  it('ignores a channel hash that is not a slot index', () => {
    expect(channelIndexFromPacket(packet({ channel: 8 }), node)).toBeUndefined();
    expect(channelIndexFromPacket(packet({ channel: 0xa7 }), node)).toBeUndefined();
    expect(channelIndexFromPacket(packet({ channel: -1 }), node)).toBeUndefined();
  });

  it('ignores PKI packets: firmware reports them as channel 0 without any channel key', () => {
    expect(channelIndexFromPacket(packet({ channel: 0, pkiEncrypted: true }), node)).toBeUndefined();
    expect(channelIndexFromPacket(packet({ channel: 0, pki_encrypted: true }), node)).toBeUndefined();
  });

  it('ignores a firmware 2.8 NodeDB replay (channel is the NodeDB value, not a reception)', () => {
    for (const kind of [2, 3, 36]) {
      expect(
        channelIndexFromPacket(packet({ id: replayId(FROM, RX_TIME, kind) }), node),
      ).toBeUndefined();
    }
  });

  it('ignores a zero-hop reply transmitted in the sender\'s name by another node', () => {
    // TrafficManagementModule: from = target, channel = request channel, hops 0/0,
    // relay_node = the answering relay's byte.
    expect(
      channelIndexFromPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: 0x42 }), node),
    ).toBeUndefined();
  });

  it('ignores an MQTT envelope injected through the Virtual Node MQTT proxy', () => {
    expect(channelIndexFromPacket(packet(), { decryptedBy: 'node', fromMqttProxy: true })).toBeUndefined();
  });
});

describe('isSpoofedZeroHopPacket (#5923)', () => {
  it('flags a zero-hop packet whose relay byte is not the sender\'s', () => {
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: 0x42 }))).toBe(true);
  });

  it('accepts a genuine zero-hop packet sent by the node itself', () => {
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: FROM & 0xff }))).toBe(false);
  });

  it('accepts a relayed packet (hops > 0) whatever the relay byte', () => {
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 3, hopLimit: 1, relayNode: 0x42 }))).toBe(false);
  });

  it('accepts legacy firmware with no hop_start', () => {
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 3, relayNode: 0x42 }))).toBe(false);
  });

  it('accepts packets with no relay byte or via MQTT', () => {
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: 0 }))).toBe(false);
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: undefined }))).toBe(false);
    expect(isSpoofedZeroHopPacket(packet({ hopStart: 0, hopLimit: 0, relayNode: 0x42, viaMqtt: true }))).toBe(false);
  });
});
