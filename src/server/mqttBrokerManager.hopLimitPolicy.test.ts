/**
 * MqttBrokerManager.transformForwardedPayload — the wire-level half of the
 * hop-limit raise/clamp policy (#5188, #5190).
 *
 * The policy arithmetic itself is covered in `mqttHopLimitPolicy.test.ts`;
 * this suite pins the encode/decode seam: which packets get rewritten, that
 * `hop_start` survives, that an encrypted packet one of our channel keys opens
 * is raised by its real portnum (#5791), and that a packet we cannot read the
 * portnum of is clamped but never raised.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createCipheriv } from 'crypto';

// The channel_database holds the default key ("AQ==") as channel 1.
vi.mock('../services/database.js', () => ({
  default: {
    settings: { getSettingForSource: async () => null },
    channelDatabase: {
      getEnabledAsync: async () => [
        { id: 1, name: 'LongFast', psk: 'AQ==', sortOrder: 0, enforceNameValidation: false },
      ],
      incrementDecryptedCountAsync: async () => undefined,
    },
  },
}));

import { MqttBrokerManager, type MqttBrokerSourceConfig } from './mqttBrokerManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import { PortNum, expandShorthandPsk } from './constants/meshtastic.js';
import { channelDecryptionService } from './services/channelDecryptionService.js';
import { getProtobufRoot } from './protobufLoader.js';

const TOPIC = 'msh/US/2/e/LongFast/!12345678';

function makeManager(extra: Partial<MqttBrokerSourceConfig>): MqttBrokerManager {
  return new MqttBrokerManager('hop-broker', 'Hop Broker', {
    listener: { port: 0, host: '127.0.0.1' },
    auth: { username: 'mm', password: 's3cret' },
    gateway: { nodeNum: 0xdeadbeef, nodeId: '!deadbeef', longName: 'MM', shortName: 'MM' },
    rootTopic: 'msh',
    ...extra,
  });
}

function buildEnvelope(opts: {
  hopLimit: number;
  hopStart?: number;
  portnum?: number;
  /** true: four bytes no key opens. 'default-key': a real Data message
   *  encrypted with the default channel key, as a phone's client proxy sends. */
  encrypted?: boolean | 'default-key';
}): Buffer {
  const packet: Record<string, unknown> = {
    from: 0x12345678,
    to: 0xffffffff,
    channel: 0,
    id: 0xabcdef01,
    hopLimit: opts.hopLimit,
    hopStart: opts.hopStart ?? opts.hopLimit,
  };
  if (opts.encrypted === 'default-key') {
    packet.encrypted = encryptWithDefaultKey(opts.portnum ?? PortNum.TEXT_MESSAGE_APP);
  } else if (opts.encrypted) {
    packet.encrypted = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  } else {
    packet.decoded = {
      portnum: opts.portnum ?? PortNum.POSITION_APP,
      payload: new Uint8Array([0x68, 0x69]),
    };
  }
  const bytes = meshtasticProtobufService.encodeServiceEnvelope({
    packet,
    channelId: 'LongFast',
    gatewayId: '!12345678',
  });
  if (!bytes) throw new Error('encode failed');
  return Buffer.from(bytes);
}

/** Encrypt a Data message the way firmware does for packet 0xabcdef01 from 0x12345678. */
function encryptWithDefaultKey(portnum: number): Uint8Array {
  const DataType = getProtobufRoot()!.lookupType('meshtastic.Data');
  const plain = DataType.encode(DataType.create({ portnum, payload: Buffer.from('hi') })).finish();
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(0xabcdef01, 0);
  nonce.writeUInt32LE(0x12345678, 8);
  const key = expandShorthandPsk(Buffer.from('AQ==', 'base64'))!;
  const cipher = createCipheriv('aes-128-ctr', key, nonce);
  return new Uint8Array(Buffer.concat([cipher.update(plain), cipher.final()]));
}

function readBack(payload: Buffer): { hopLimit: number; hopStart: number | undefined } {
  const decoded = meshtasticProtobufService.decodeServiceEnvelope(payload);
  if (!decoded) throw new Error('decode failed');
  // proto3 omits zero on the wire.
  return { hopLimit: decoded.packet.hopLimit ?? 0, hopStart: decoded.packet.hopStart };
}

describe('MqttBrokerManager hop-limit policy', () => {
  beforeAll(async () => {
    await meshtasticProtobufService.initialize();
  });

  it('returns null when the source has no policy at all', () => {
    const mgr = makeManager({});
    expect(mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 7 }))).toBeNull();
  });

  it('ignores topics outside the configured root', () => {
    const mgr = makeManager({ hopLimitPolicy: { clamp: { enabled: true, max: 1 } } });
    expect(
      mgr.transformForwardedPayload('other/US/2/e/LongFast/!1', buildEnvelope({ hopLimit: 7 })),
    ).toBeNull();
  });

  it('clamps a hop limit above the maximum', () => {
    const mgr = makeManager({ hopLimitPolicy: { clamp: { enabled: true, max: 3 } } });
    const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 7 }));
    expect(out).not.toBeNull();
    expect(readBack(out!).hopLimit).toBe(3);
  });

  it('leaves hop_start alone when it clamps', () => {
    const mgr = makeManager({ hopLimitPolicy: { clamp: { enabled: true, max: 2 } } });
    const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 7, hopStart: 7 }));
    expect(readBack(out!)).toEqual({ hopLimit: 2, hopStart: 7 });
  });

  it('returns null rather than re-encoding when the clamp is a no-op', () => {
    const mgr = makeManager({ hopLimitPolicy: { clamp: { enabled: true, max: 5 } } });
    expect(mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 2 }))).toBeNull();
  });

  it('raises a hop limit on an opted-in portnum', () => {
    const mgr = makeManager({
      hopLimitPolicy: { raise: { enabled: true, target: 3, portnums: [PortNum.POSITION_APP] } },
    });
    const out = mgr.transformForwardedPayload(
      TOPIC,
      buildEnvelope({ hopLimit: 1, portnum: PortNum.POSITION_APP }),
    );
    expect(readBack(out!).hopLimit).toBe(3);
  });

  it('leaves a portnum the operator did not opt in alone', () => {
    const mgr = makeManager({
      hopLimitPolicy: { raise: { enabled: true, target: 3, portnums: [PortNum.POSITION_APP] } },
    });
    expect(
      mgr.transformForwardedPayload(
        TOPIC,
        buildEnvelope({ hopLimit: 1, portnum: PortNum.TELEMETRY_APP }),
      ),
    ).toBeNull();
  });

  it('never raises an encrypted packet that none of our keys opens', () => {
    const mgr = makeManager({
      hopLimitPolicy: { raise: { enabled: true, target: 3, portnums: [PortNum.POSITION_APP] } },
    });
    expect(
      mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 1, encrypted: true })),
    ).toBeNull();
  });

  it('still clamps an encrypted packet', () => {
    const mgr = makeManager({ hopLimitPolicy: { clamp: { enabled: true, max: 2 } } });
    const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 7, encrypted: true }));
    expect(readBack(out!).hopLimit).toBe(2);
  });

  describe('encrypted uplinks (#5791)', () => {
    const raiseText = {
      hopLimitPolicy: { raise: { enabled: true, target: 2, portnums: [PortNum.TEXT_MESSAGE_APP] } },
    };

    beforeAll(async () => {
      await channelDecryptionService.refreshChannelCache();
    });

    it('raises encrypted text when a held channel key reveals the portnum', () => {
      const mgr = makeManager(raiseText);
      const env = buildEnvelope({ hopLimit: 0, hopStart: 3, encrypted: 'default-key' });
      const out = mgr.transformForwardedPayload(TOPIC, env);
      expect(readBack(out!)).toEqual({ hopLimit: 2, hopStart: 3 });
    });

    it('keeps the ciphertext byte for byte', () => {
      const mgr = makeManager(raiseText);
      const env = buildEnvelope({ hopLimit: 0, encrypted: 'default-key' });
      const before = meshtasticProtobufService.decodeServiceEnvelope(env)!.packet.encrypted;
      const after = meshtasticProtobufService.decodeServiceEnvelope(mgr.transformForwardedPayload(TOPIC, env)!)!.packet;
      expect(Buffer.from(after.encrypted)).toEqual(Buffer.from(before));
      expect(after.decoded).toBeFalsy();
    });

    it('leaves an encrypted portnum the operator did not opt in alone', () => {
      const mgr = makeManager(raiseText);
      const env = buildEnvelope({ hopLimit: 0, portnum: PortNum.POSITION_APP, encrypted: 'default-key' });
      expect(mgr.transformForwardedPayload(TOPIC, env)).toBeNull();
    });

    it('honours a clamp exemption on an encrypted packet it can read', () => {
      const mgr = makeManager({
        hopLimitPolicy: { clamp: { enabled: true, max: 1, exemptPortnums: [PortNum.TEXT_MESSAGE_APP] } },
      });
      const env = buildEnvelope({ hopLimit: 4, encrypted: 'default-key' });
      expect(mgr.transformForwardedPayload(TOPIC, env)).toBeNull();
    });

    it('raises nothing when server-side decryption is turned off', () => {
      const mgr = makeManager(raiseText);
      channelDecryptionService.setEnabled(false);
      try {
        const env = buildEnvelope({ hopLimit: 0, encrypted: 'default-key' });
        expect(mgr.transformForwardedPayload(TOPIC, env)).toBeNull();
      } finally {
        channelDecryptionService.setEnabled(true);
      }
    });
  });

  it('applies the clamp after the raise', () => {
    const mgr = makeManager({
      hopLimitPolicy: {
        raise: { enabled: true, target: 3, portnums: [PortNum.POSITION_APP] },
        clamp: { enabled: true, max: 2 },
      },
    });
    const out = mgr.transformForwardedPayload(
      TOPIC,
      buildEnvelope({ hopLimit: 1, portnum: PortNum.POSITION_APP }),
    );
    expect(readBack(out!).hopLimit).toBe(2);
  });

  it('honors a legacy downlinkHopLimitOverride with no policy stored', () => {
    const mgr = makeManager({ downlinkHopLimitOverride: 0 });
    const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 3, hopStart: 3 }));
    expect(readBack(out!)).toEqual({ hopLimit: 0, hopStart: 3 });
  });

  it('reads an absent hop_limit as 0, so a legacy raise-to-N still fires', () => {
    // proto3 omits zero, so a packet from a zero-hop upstream decodes with no
    // hopLimit field at all — exactly the case #4081 existed to rewrite.
    const mgr = makeManager({ downlinkHopLimitOverride: 3 });
    const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 0, hopStart: 0 }));
    expect(readBack(out!).hopLimit).toBe(3);
  });

  describe('per-bridge skip raise (#5708)', () => {
    const policy = {
      hopLimitPolicy: {
        raise: { enabled: true, target: 3, portnums: [PortNum.POSITION_APP, PortNum.TEXT_MESSAGE_APP] },
        clamp: { enabled: true, max: 2 },
      },
    };

    it('a marked packet is clamped but never raised; others are raised as before', () => {
      const mgr = makeManager({ hopLimitPolicy: { raise: policy.hopLimitPolicy.raise } } as never);
      const env = buildEnvelope({ hopLimit: 0, portnum: PortNum.POSITION_APP });
      expect(readBack(mgr.transformForwardedPayload(TOPIC, env)!).hopLimit).toBe(3);
      mgr.markSkipRaise(0x12345678, 0xabcdef01);
      expect(mgr.transformForwardedPayload(TOPIC, env)).toBeNull(); // 0 stays 0
    });

    it('still clamps a marked packet', () => {
      const mgr = makeManager(policy as never);
      mgr.markSkipRaise(0x12345678, 0xabcdef01);
      const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 6, portnum: PortNum.POSITION_APP }));
      expect(readBack(out!).hopLimit).toBe(2);
    });

    it('a mark expires after a minute', () => {
      vi.useFakeTimers();
      try {
        const mgr = makeManager({ hopLimitPolicy: { raise: policy.hopLimitPolicy.raise } } as never);
        mgr.markSkipRaise(0x12345678, 0xabcdef01);
        vi.advanceTimersByTime(61_000);
        const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 0, portnum: PortNum.TEXT_MESSAGE_APP }));
        expect(readBack(out!).hopLimit).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a mark for another packet id does not apply', () => {
      const mgr = makeManager({ hopLimitPolicy: { raise: policy.hopLimitPolicy.raise } } as never);
      mgr.markSkipRaise(0x12345678, 0x1);
      const out = mgr.transformForwardedPayload(TOPIC, buildEnvelope({ hopLimit: 0, portnum: PortNum.POSITION_APP }));
      expect(readBack(out!).hopLimit).toBe(3);
    });
  });
});
