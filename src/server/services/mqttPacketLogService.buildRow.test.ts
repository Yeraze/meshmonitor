/**
 * Unit tests for `buildMqttPacketLogRow` (and its private helpers, exercised
 * indirectly) — pure functions, no DB. See
 * docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §4.6.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: {},
}));

import { buildMqttPacketLogRow } from './mqttPacketLogService.js';
import type { ServiceEnvelopeShape } from '../mqttPacketFilter.js';
import type { MqttIngestionResult } from '../mqttIngestion.js';
import { PortNum } from '../constants/meshtastic.js';

function envelope(overrides: Partial<ServiceEnvelopeShape> = {}): ServiceEnvelopeShape {
  return {
    channelId: 'LongFast',
    gatewayId: '!433e0f28',
    packet: {
      id: 0x12345678,
      from: 0x11111111,
      to: 0xffffffff,
      channel: 8,
      rxTime: 1_700_000_000,
      rxSnr: 5.5,
      rxRssi: -80,
      hopLimit: 3,
      hopStart: 3,
      decoded: { portnum: PortNum.TEXT_MESSAGE_APP, payload: new TextEncoder().encode('hello world') },
    },
    ...overrides,
  };
}

describe('buildMqttPacketLogRow', () => {
  it('returns null when the envelope has no packet', () => {
    const row = buildMqttPacketLogRow('src-a', {}, { ingested: false, reason: 'no-packet' });
    expect(row).toBeNull();
  });

  describe('outcome mapping (mapOutcome)', () => {
    const cases: Array<[MqttIngestionResult, string]> = [
      [{ ingested: true, portnum: 1 }, 'ingested'],
      [{ ingested: false, reason: 'encrypted' }, 'encrypted'],
      [{ ingested: false, reason: 'ignored' }, 'ignored'],
      [{ ingested: false, reason: 'geo-ignored' }, 'geo-ignored'],
      [{ ingested: false, reason: 'unsupported-portnum' }, 'unsupported-portnum'],
      [{ ingested: false, reason: 'decode-error' }, 'decode-error'],
      [{ ingested: false, reason: 'no-decoded' }, 'decode-error'],
      [{ ingested: false, reason: 'no-packet' }, 'decode-error'],
      [{ ingested: false }, 'decode-error'],
    ];
    it.each(cases)('maps %j -> %s', (result, expected) => {
      const row = buildMqttPacketLogRow('src-a', envelope(), result);
      expect(row?.ingestOutcome).toBe(expected);
    });

    it('ingested:true always wins even if a reason is also set', () => {
      const row = buildMqttPacketLogRow('src-a', envelope(), {
        ingested: true,
        reason: 'geo-ignored' as any,
        portnum: 1,
      });
      expect(row?.ingestOutcome).toBe('ingested');
    });
  });

  describe('gatewayId parsing (parseGatewayNodeNum)', () => {
    it('parses a well-formed !aabbccdd gateway id to its numeric nodeNum', () => {
      const row = buildMqttPacketLogRow(
        'src-a',
        envelope({ gatewayId: '!433e0f28' }),
        { ingested: true, portnum: 1 },
      );
      expect(row?.gatewayId).toBe('!433e0f28');
      expect(row?.gatewayNodeNum).toBe(0x433e0f28);
    });

    it('returns null for a malformed gateway id (no leading !)', () => {
      const row = buildMqttPacketLogRow(
        'src-a',
        envelope({ gatewayId: '433e0f28' }),
        { ingested: true, portnum: 1 },
      );
      expect(row?.gatewayNodeNum).toBeNull();
    });

    it('returns null for a non-hex gateway id', () => {
      const row = buildMqttPacketLogRow(
        'src-a',
        envelope({ gatewayId: '!zzzzzzzz' }),
        { ingested: true, portnum: 1 },
      );
      expect(row?.gatewayNodeNum).toBeNull();
    });

    it('returns null when gatewayId is missing', () => {
      const row = buildMqttPacketLogRow(
        'src-a',
        envelope({ gatewayId: undefined }),
        { ingested: true, portnum: 1 },
      );
      expect(row?.gatewayId).toBeNull();
      expect(row?.gatewayNodeNum).toBeNull();
    });
  });

  describe('rxTime handling', () => {
    it('converts a positive rxTime (seconds) to milliseconds', () => {
      const row = buildMqttPacketLogRow(
        'src-a',
        envelope({ packet: { ...envelope().packet, rxTime: 1_700_000_000 } }),
        { ingested: true, portnum: 1 },
      );
      expect(row?.rxTime).toBe(1_700_000_000 * 1000);
    });

    it('stores null when rxTime is 0', () => {
      const env = envelope();
      env.packet!.rxTime = 0;
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: 1 });
      expect(row?.rxTime).toBeNull();
    });

    it('stores null when rxTime is negative', () => {
      const env = envelope();
      env.packet!.rxTime = -5;
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: 1 });
      expect(row?.rxTime).toBeNull();
    });

    it('stores null when rxTime is absent', () => {
      const env = envelope();
      delete env.packet!.rxTime;
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: 1 });
      expect(row?.rxTime).toBeNull();
    });
  });

  describe('payload preview (buildPreview)', () => {
    it('builds a text preview for TEXT_MESSAGE_APP', () => {
      const row = buildMqttPacketLogRow('src-a', envelope(), { ingested: true, portnum: 1 });
      expect(row?.payloadPreview).toBe('hello world');
    });

    it('is null for a non-text portnum even with a payload present', () => {
      const env = envelope({
        packet: {
          ...envelope().packet,
          decoded: { portnum: PortNum.POSITION_APP, payload: new Uint8Array([1, 2, 3]) },
        },
      });
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: PortNum.POSITION_APP });
      expect(row?.payloadPreview).toBeNull();
    });

    it('is null when there is no decoded payload (encrypted, undecoded)', () => {
      const env: ServiceEnvelopeShape = {
        channelId: 'LongFast',
        gatewayId: '!433e0f28',
        packet: {
          id: 1,
          from: 0x11111111,
          to: 0xffffffff,
          channel: 8,
          encrypted: new Uint8Array([9, 9, 9]),
        },
      };
      const row = buildMqttPacketLogRow('src-a', env, { ingested: false, reason: 'encrypted' });
      expect(row?.payloadPreview).toBeNull();
      expect(row?.portnum).toBeNull();
    });

    it('truncates a text preview to 256 characters', () => {
      const longText = 'x'.repeat(300);
      const env = envelope({
        packet: {
          ...envelope().packet,
          decoded: { portnum: PortNum.TEXT_MESSAGE_APP, payload: new TextEncoder().encode(longText) },
        },
      });
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: 1 });
      expect(row?.payloadPreview).toHaveLength(256);
    });
  });

  describe('encrypted / decryptedBy logic', () => {
    it('encrypted=0, decryptedBy=null for a normally-decoded (never encrypted) packet', () => {
      const row = buildMqttPacketLogRow('src-a', envelope(), { ingested: true, portnum: 1 });
      expect(row?.encrypted).toBe(0);
      expect(row?.decryptedBy).toBeNull();
    });

    it('encrypted=1, decryptedBy=null for an encrypted packet with no decoded field (undecryptable)', () => {
      const env: ServiceEnvelopeShape = {
        channelId: 'LongFast',
        gatewayId: '!433e0f28',
        packet: {
          id: 1,
          from: 0x11111111,
          to: 0xffffffff,
          channel: 8,
          encrypted: new Uint8Array([9, 9, 9]),
        },
      };
      const row = buildMqttPacketLogRow('src-a', env, { ingested: false, reason: 'encrypted' });
      expect(row?.encrypted).toBe(1);
      expect(row?.decryptedBy).toBeNull();
      expect(row?.payloadSize).toBe(3); // falls back to encrypted.length
    });

    it('encrypted=1, decryptedBy="server" for a packet with both encrypted bytes and a synthesized decoded field', () => {
      const env: ServiceEnvelopeShape = {
        channelId: 'LongFast',
        gatewayId: '!433e0f28',
        packet: {
          id: 1,
          from: 0x11111111,
          to: 0xffffffff,
          channel: 8,
          encrypted: new Uint8Array([9, 9, 9]),
          decoded: { portnum: PortNum.TEXT_MESSAGE_APP, payload: new TextEncoder().encode('decrypted!') },
        },
      };
      const row = buildMqttPacketLogRow('src-a', env, { ingested: true, portnum: 1 });
      expect(row?.encrypted).toBe(1);
      expect(row?.decryptedBy).toBe('server');
      expect(row?.ingestOutcome).toBe('ingested');
      expect(row?.payloadPreview).toBe('decrypted!');
    });
  });

  describe('portnum / portnumName / node id fields', () => {
    it('resolves portnumName from a valid portnum', () => {
      const row = buildMqttPacketLogRow('src-a', envelope(), { ingested: true, portnum: 1 });
      expect(row?.portnum).toBe(PortNum.TEXT_MESSAGE_APP);
      expect(row?.portnumName).toBe('TEXT_MESSAGE_APP');
    });

    it('portnum/portnumName are null when there is no decoded field', () => {
      const env: ServiceEnvelopeShape = {
        channelId: 'LongFast',
        gatewayId: '!433e0f28',
        packet: { id: 1, from: 0x11111111, to: 0xffffffff, channel: 8, encrypted: new Uint8Array([1]) },
      };
      const row = buildMqttPacketLogRow('src-a', env, { ingested: false, reason: 'encrypted' });
      expect(row?.portnum).toBeNull();
      expect(row?.portnumName).toBeNull();
    });

    it('derives fromNodeId/toNodeId as !aabbccdd from the numeric node numbers', () => {
      const row = buildMqttPacketLogRow('src-a', envelope(), { ingested: true, portnum: 1 });
      expect(row?.fromNodeId).toBe('!11111111');
      expect(row?.toNodeId).toBe('!ffffffff');
    });

    it('carries sourceId, channel, and channelId through unchanged', () => {
      const row = buildMqttPacketLogRow('src-b', envelope(), { ingested: true, portnum: 1 });
      expect(row?.sourceId).toBe('src-b');
      expect(row?.channel).toBe(8);
      expect(row?.channelId).toBe('LongFast');
    });
  });
});
