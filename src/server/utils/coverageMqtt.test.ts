/**
 * Tests for `evaluateMqttCoverageReception`, the pure MQTT gateway-reception
 * skip-rule evaluator for the Coverage Report (#5277 P2, §2.6 / §3). One
 * case per skip rule, in spec order.
 */
import { describe, it, expect } from 'vitest';
import { TransportMechanism } from '../constants/meshtastic.js';
import { evaluateMqttCoverageReception, type MqttCoverageEvalResult } from './coverageMqtt.js';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';

const SOURCE_ID = 'src-a';
const GATEWAY_NUM = 0x00000001;
const GATEWAY_ID = '!00000001';
const FROM_NUM = 0x11111111;
const PACKET_ID = 0x12345678;
const NOW_MS = new Date('2024-01-01T00:00:00.000Z').getTime();
const FRESH_RX_TIME = Math.floor(NOW_MS / 1000) - 10;

function envelope(
  packetOverrides: Record<string, unknown> = {},
  gatewayId: string | undefined = GATEWAY_ID,
): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId,
    packet: {
      id: PACKET_ID,
      from: FROM_NUM,
      to: 0xffffffff,
      channel: 8,
      rxTime: FRESH_RX_TIME,
      rxSnr: -5.5,
      rxRssi: -80,
      hopStart: 3,
      hopLimit: 2,
      relayNode: 0x42,
      transportMechanism: TransportMechanism.LORA,
      decoded: { bitfield: 1 }, // bit 0 set => ok_to_mqtt 'yes'
      ...packetOverrides,
    } as ServiceEnvelopeShape['packet'],
  };
}

function evalDefault(
  overrides: Partial<Parameters<typeof evaluateMqttCoverageReception>[0]> = {},
  packetOverrides: Record<string, unknown> = {},
  gatewayId: string | undefined = GATEWAY_ID,
): MqttCoverageEvalResult {
  return evaluateMqttCoverageReception({
    sourceId: SOURCE_ID,
    envelope: envelope(packetOverrides, gatewayId),
    fromNum: FROM_NUM,
    localGatewayNodeNum: null,
    nowMs: NOW_MS,
    isOwnNodeNum: () => false,
    isIgnored: () => false,
    ...overrides,
  });
}

describe('evaluateMqttCoverageReception', () => {
  it('skips a missing gatewayId', () => {
    const withoutGateway = envelope();
    delete withoutGateway.gatewayId;
    const result = evaluateMqttCoverageReception({
      sourceId: SOURCE_ID,
      envelope: withoutGateway,
      fromNum: FROM_NUM,
      localGatewayNodeNum: null,
      nowMs: NOW_MS,
      isOwnNodeNum: () => false,
      isIgnored: () => false,
    });
    expect(result).toEqual({ skip: 'no-gateway' });
  });

  it('skips a malformed gatewayId', () => {
    expect(evalDefault({}, {}, 'not-a-gateway-id')).toEqual({ skip: 'no-gateway' });
  });

  it('skips the gateway reporting its own position (from === gateway)', () => {
    const result = evalDefault({ fromNum: GATEWAY_NUM });
    expect(result).toEqual({ skip: 'own-packet' });
  });

  it('skips our own publish echoed back (local gateway)', () => {
    const result = evalDefault({ localGatewayNodeNum: GATEWAY_NUM });
    expect(result).toEqual({ skip: 'local-gateway' });
  });

  it('skips a gateway that is one of our own radio sources (D3)', () => {
    const result = evalDefault({ isOwnNodeNum: (n: number) => n === GATEWAY_NUM });
    expect(result).toEqual({ skip: 'own-node-gateway' });
  });

  it('skips a packet firmware flagged viaMqtt (belt and braces)', () => {
    const result = evalDefault({}, { viaMqtt: true });
    expect(result).toEqual({ skip: 'via-mqtt' });
  });

  describe('transport', () => {
    it('skips an own-present non-RF transport (Multicast UDP)', () => {
      const result = evalDefault({}, { transportMechanism: TransportMechanism.MULTICAST_UDP });
      expect(result).toEqual({ skip: 'non-rf' });
    });

    it('allows a prototype-default 0 with no own property (old firmware)', () => {
      // Simulate a protobufjs decoded message where `transportMechanism` is
      // reachable only via the prototype chain (default value), never set
      // as an own property on the instance itself.
      const proto = { transportMechanism: 0 };
      const packet = Object.assign(Object.create(proto), {
        id: PACKET_ID,
        from: FROM_NUM,
        rxTime: FRESH_RX_TIME,
        rxSnr: -5.5,
        rxRssi: -80,
        hopStart: 3,
        hopLimit: 2,
        relayNode: 0x42,
        decoded: { bitfield: 1 },
      });
      expect(Object.prototype.hasOwnProperty.call(packet, 'transportMechanism')).toBe(false);
      const result = evaluateMqttCoverageReception({
        sourceId: SOURCE_ID,
        envelope: { channelId: 'LongFast', gatewayId: GATEWAY_ID, packet },
        fromNum: FROM_NUM,
        localGatewayNodeNum: null,
        nowMs: NOW_MS,
        isOwnNodeNum: () => false,
        isIgnored: () => false,
      });
      expect(result.skip).toBeNull();
      if (result.skip === null) {
        expect(result.row.transportMechanism).toBeNull();
      }
    });

    it('allows LORA_ALT1 (a secondary radio is still RF)', () => {
      const result = evalDefault({}, { transportMechanism: TransportMechanism.LORA_ALT1 });
      expect(result.skip).toBeNull();
    });
  });

  describe('signal', () => {
    it('skips snr 0 with no rssi at all (local/UDP/pre-transport-field copy)', () => {
      const result = evalDefault({}, { rxSnr: 0, rxRssi: undefined });
      expect(result).toEqual({ skip: 'no-signal' });
    });

    it('keeps snr 0 with rssi present', () => {
      const result = evalDefault({}, { rxSnr: 0, rxRssi: -100 });
      expect(result.skip).toBeNull();
      if (result.skip === null) {
        expect(result.row.snr).toBe(0);
        expect(result.row.rssi).toBe(-100);
      }
    });

    it('normalizes SNR -128 (firmware "no SNR" sentinel) to null', () => {
      const result = evalDefault({}, { rxSnr: -128, rxRssi: -80 });
      expect(result.skip).toBeNull();
      if (result.skip === null) {
        expect(result.row.snr).toBeNull();
      }
    });
  });

  describe('packet id', () => {
    it('skips packetId 0', () => {
      expect(evalDefault({}, { id: 0 })).toEqual({ skip: 'no-packet-id' });
    });

    it('skips a missing packetId', () => {
      expect(evalDefault({}, { id: undefined })).toEqual({ skip: 'no-packet-id' });
    });
  });

  describe('staleness (D1)', () => {
    it('skips rxTime 11 minutes old', () => {
      const result = evalDefault({}, { rxTime: Math.floor(NOW_MS / 1000) - 11 * 60 });
      expect(result).toEqual({ skip: 'stale' });
    });

    it('keeps an absent rxTime (gateway with no RTC)', () => {
      const result = evalDefault({}, { rxTime: undefined });
      expect(result.skip).toBeNull();
    });

    it('keeps a future rxTime (clock ahead)', () => {
      const result = evalDefault({}, { rxTime: Math.floor(NOW_MS / 1000) + 3600 });
      expect(result.skip).toBeNull();
    });
  });

  describe('ok_to_mqtt (D4)', () => {
    it('skips when the originator cleared bit 0', () => {
      const result = evalDefault({}, { decoded: { bitfield: 0 } });
      expect(result).toEqual({ skip: 'ok-to-mqtt-no' });
    });

    it('keeps an unreadable bit (encrypted / undecryptable)', () => {
      const result = evalDefault({}, { decoded: {} });
      expect(result.skip).toBeNull();
    });
  });

  it('skips an ignored gateway', () => {
    const result = evalDefault({ isIgnored: (n: number) => n === GATEWAY_NUM });
    expect(result).toEqual({ skip: 'ignored-gateway' });
  });

  describe('happy path', () => {
    it('records the full row for a genuine gateway reception', () => {
      const result = evalDefault();
      expect(result.skip).toBeNull();
      if (result.skip !== null) return;
      expect(result.gatewayNum).toBe(GATEWAY_NUM);
      expect(result.row).toEqual({
        sourceId: SOURCE_ID,
        protocol: 'meshtastic',
        receiverKind: 'mqtt_gateway',
        receiverId: GATEWAY_ID,
        receiverNodeNum: GATEWAY_NUM,
        senderId: `!${FROM_NUM.toString(16).padStart(8, '0')}`,
        senderNodeNum: FROM_NUM,
        packetKey: String(PACKET_ID),
        packetId: PACKET_ID,
        pathKey: 'r66:h1', // relayNode 0x42=66, hopsAway = hopStart(3)-hopLimit(2)=1
        snr: -5.5,
        rssi: -80,
        hopStart: 3,
        hopLimit: 2,
        hopsAway: 1,
        relayNode: 0x42,
        transportMechanism: TransportMechanism.LORA,
        rxTime: FRESH_RX_TIME,
      });
    });

    it('a true zero-hop packet (0/0 with a wire-present bitfield) records hopsAway 0, pathKey r0:h0', () => {
      const result = evalDefault({}, { hopStart: 0, hopLimit: 0, relayNode: 0, decoded: { bitfield: 0 } });
      // bitfield 0 clears ok_to_mqtt, which would skip before hopsAway is computed —
      // use a channel-hash-only case where ok_to_mqtt reads 'unknown' instead by
      // omitting bitfield from the ok-to-mqtt read path is not possible (same
      // field drives both). Set bit 0 so ok_to_mqtt reads 'yes' while still
      // wire-present at 0/0.
      const resultKept = evalDefault({}, { hopStart: 0, hopLimit: 0, relayNode: 0, decoded: { bitfield: 1 } });
      expect(resultKept.skip).toBeNull();
      if (resultKept.skip === null) {
        expect(resultKept.row.hopsAway).toBe(0);
        expect(resultKept.row.pathKey).toBe('r0:h0');
      }
      // The bitfield-0 (ok_to_mqtt clear) variant is correctly skipped, not silently mis-scored.
      expect(result).toEqual({ skip: 'ok-to-mqtt-no' });
    });

    it('the same 0/0 packet WITHOUT a bitfield records hopsAway null, pathKey r0:h-', () => {
      const result = evalDefault({}, { hopStart: 0, hopLimit: 0, relayNode: 0, decoded: {} });
      expect(result.skip).toBeNull();
      if (result.skip === null) {
        expect(result.row.hopsAway).toBeNull();
        expect(result.row.pathKey).toBe('r0:h-');
      }
    });
  });
});
