/**
 * Channel encryption for Avoid PKI (#5711).
 *
 * The cipher output is checked against MeshMonitor's independent decrypt path
 * (`channelDecryptionService`, which reads real over-the-air traffic from MQTT),
 * and the channel hash against the well-known LongFast default (hash 8).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: {
    channelDatabase: {
      getEnabledAsync: vi.fn(async () => [
        { id: 1, name: 'LongFast', psk: 'AQ==', enforceNameValidation: true, sortOrder: 0 },
        { id: 2, name: 'Secret', psk: Buffer.alloc(32, 9).toString('base64'), enforceNameValidation: true, sortOrder: 1 },
      ]),
      incrementDecryptedCountAsync: vi.fn().mockResolvedValue(undefined),
    },
  },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import {
  resolveChannelKey,
  encryptChannelPayload,
  channelEncryptToRadio,
  type RadioChannel,
} from './channelEncryption.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';
import { channelDecryptionService } from '../services/channelDecryptionService.js';
import { PortNum } from '../constants/meshtastic.js';

const FROM = 0x0a0a0a0a;
const LONG_FAST = 0;

function chans(...list: RadioChannel[]): Map<number, RadioChannel> {
  return new Map(list.map((c) => [c.index, c]));
}
const primaryDefault: RadioChannel = { index: 0, role: 1, name: '', psk: new Uint8Array([1]), useAead: false };
const secret: RadioChannel = { index: 2, role: 2, name: 'Secret', psk: new Uint8Array(32).fill(9), useAead: false };
const lora = { usePreset: true, modemPreset: LONG_FAST };

describe('resolveChannelKey', () => {
  it('default LongFast primary: firmware hash 8, default key', () => {
    const r = resolveChannelKey(0, chans(primaryDefault), lora);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channelKey.hash).toBe(8);
    expect(r.channelKey.key.toString('base64')).toBe('1PG7OiApB1nwvP+rz05pAQ==');
  });

  it('shorthand PSK n bumps the last key byte by n-1', () => {
    const r = resolveChannelKey(0, chans({ ...primaryDefault, psk: new Uint8Array([3]) }), lora);
    expect(r.ok && r.channelKey.key[15]).toBe(0x03);
  });

  it('named channel with a 32-byte key', () => {
    const r = resolveChannelKey(2, chans(primaryDefault, secret), lora);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channelKey.key).toHaveLength(32);
  });

  it('a secondary with no PSK borrows the primary key', () => {
    const r = resolveChannelKey(1, chans(primaryDefault, { index: 1, role: 2, name: 'Borrow', psk: new Uint8Array(), useAead: false }), lora);
    expect(r.ok && r.channelKey.key.toString('base64')).toBe('1PG7OiApB1nwvP+rz05pAQ==');
  });

  it('an empty name without a preset is "Custom"', () => {
    const a = resolveChannelKey(0, chans(primaryDefault), { usePreset: false });
    const b = resolveChannelKey(0, chans({ ...primaryDefault, name: 'Custom' }), lora);
    expect(a.ok && b.ok && a.channelKey.hash === b.channelKey.hash).toBe(true);
  });

  it.each([
    ['slot not reported', chans(primaryDefault), 3, lora],
    ['disabled slot', chans(primaryDefault, { ...secret, role: 0 }), 2, lora],
    ['AEAD channel', chans(primaryDefault, { ...secret, useAead: true }), 2, lora],
    ['LoRa config unknown for a default name', chans(primaryDefault), 0, null],
  ])('refuses: %s', (_label, channels, index, l) => {
    expect(resolveChannelKey(index as number, channels as Map<number, RadioChannel>, l as typeof lora | null).ok).toBe(false);
  });

  it('refuses a channel whose hash is 0 (the radio would overwrite it)', () => {
    // xor("A") = 0x41; a 16-byte key whose bytes xor to 0x41 gives hash 0.
    const psk = new Uint8Array(16);
    psk[0] = 0x41;
    const r = resolveChannelKey(1, chans(primaryDefault, { index: 1, role: 2, name: 'A', psk, useAead: false }), lora);
    expect(r).toEqual({ ok: false, reason: 'channel 1 hashes to 0' });
  });
});

describe('channelEncryptToRadio', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  function telemetryRequestFrame(id: number, to: number) {
    const root = getProtobufRoot()!;
    const Data = root.lookupType('meshtastic.Data');
    const MeshPacket = root.lookupType('meshtastic.MeshPacket');
    const ToRadio = root.lookupType('meshtastic.ToRadio');
    const decoded = Data.create({ portnum: PortNum.TELEMETRY_APP, payload: new Uint8Array([0x12, 0x00]), wantResponse: true, dest: to, requestId: 77 });
    const packet = MeshPacket.create({ id, to, channel: 2, decoded, wantAck: true, hopLimit: 3 });
    return ToRadio.encode(ToRadio.create({ packet })).finish();
  }

  it.each([
    ['default LongFast (AES-128)', 0, 'LongFast'],
    ['named channel (AES-256)', 2, 'Secret'],
  ])('%s: the result decrypts with MeshMonitor\'s independent channel decryptor', async (_label, index, expectedName) => {
    const resolved = resolveChannelKey(index, chans(primaryDefault, secret), lora);
    if (!resolved.ok) throw new Error(resolved.reason);
    const root = getProtobufRoot()!;
    const out = channelEncryptToRadio(root as any, telemetryRequestFrame(0x1234abcd, 0x22222222), resolved.channelKey, FROM, false)!;
    const p = (root.lookupType('meshtastic.ToRadio').decode(out) as any).packet;

    expect(p.decoded ?? null).toBeNull();
    expect(p.encrypted.length).toBeGreaterThan(0);
    expect(p.channel).toBe(resolved.channelKey.hash);
    expect(p.id >>> 0).toBe(0x1234abcd);
    expect(p.to >>> 0).toBe(0x22222222);
    expect(p.wantAck).toBe(true);
    expect(p.hopLimit).toBe(3);
    expect(p.pkiEncrypted ?? false).toBe(false);

    channelDecryptionService.invalidateCache();
    const res = await channelDecryptionService.tryDecrypt(p.encrypted, p.id >>> 0, FROM, p.channel);
    expect(res.success).toBe(true);
    expect(res.channelName).toBe(expectedName);
    expect(res.portnum).toBe(PortNum.TELEMETRY_APP);
    expect(res.requestId).toBe(77);
  });

  it('sets the bitfield the firmware sets on packets it originates (want_response, ok_to_mqtt)', () => {
    const resolved = resolveChannelKey(0, chans(primaryDefault), lora);
    if (!resolved.ok) throw new Error(resolved.reason);
    const root = getProtobufRoot()!;
    const out = channelEncryptToRadio(root as any, telemetryRequestFrame(5, 0x22222222), resolved.channelKey, FROM, true)!;
    const p = (root.lookupType('meshtastic.ToRadio').decode(out) as any).packet;
    const plain = encryptChannelPayload(resolved.channelKey.key, 5, FROM, p.encrypted); // CTR is symmetric
    const data = root.lookupType('meshtastic.Data').decode(plain) as any;
    expect(data.bitfield).toBe(0b11);
    expect(data.wantResponse).toBe(true);
  });

  it('refuses a broadcast or a packet without an id', () => {
    const resolved = resolveChannelKey(0, chans(primaryDefault), lora);
    if (!resolved.ok) throw new Error(resolved.reason);
    const root = getProtobufRoot()!;
    expect(channelEncryptToRadio(root as any, telemetryRequestFrame(0, 0x22222222), resolved.channelKey, FROM, false)).toBeNull();
    expect(channelEncryptToRadio(root as any, telemetryRequestFrame(9, 0xffffffff), resolved.channelKey, FROM, false)).toBeNull();
  });
});
