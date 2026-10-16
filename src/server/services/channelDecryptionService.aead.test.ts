/**
 * AEAD (AES-CCM) channels, firmware 2.8.1+ (#5248 Phase 2).
 *
 * Packets are built with the firmware's own layout (CryptoEngine.cpp at
 * v2.8.1.8e6a88d): 13-byte nonce = LE64(packetId) ‖ LE32(from) ‖ 0x00,
 * AAD = LE32(from) ‖ LE32(to), payload = ciphertext ‖ 12-byte tag.
 */
import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { createCipheriv, createDecipheriv } from 'crypto';
import { channelDecryptionService, computeChannelHash } from './channelDecryptionService.js';
import databaseService from '../../services/database.js';
import * as protobufLoader from '../protobufLoader.js';
import { logger } from '../../utils/logger.js';

vi.mock('../protobufLoader.js', () => ({ getProtobufRoot: vi.fn() }));
vi.mock('../../services/database.js', () => ({
  default: {
    channelDatabase: {
      getEnabledAsync: vi.fn(),
      incrementDecryptedCountAsync: vi.fn(),
    },
  },
}));

const KEY = Buffer.from('d4f1bb3a20290759f0bcffabcf4e6901', 'hex'); // firmware test_crypto PSK
const FROM = 0x12345678;
const TO = 0xffffffff;
const PACKET_ID = 0xaabbccdd;
const PLAINTEXT = Buffer.from('08011204746573744800', 'hex'); // Data{portnum:1, payload:"test"}

function firmwareNonce(packetId: number, from: number): Buffer {
  const n = Buffer.alloc(13);
  n.writeUInt32LE(packetId >>> 0, 0);
  n.writeUInt32LE(from >>> 0, 8);
  return n;
}

function encryptCcm(plain: Buffer, key = KEY, from = FROM, to = TO, id = PACKET_ID): Uint8Array {
  const aad = Buffer.alloc(8);
  aad.writeUInt32LE(from >>> 0, 0);
  aad.writeUInt32LE(to >>> 0, 4);
  const c = createCipheriv(key.length === 16 ? 'aes-128-ccm' : 'aes-256-ccm', key, firmwareNonce(id, from), {
    authTagLength: 12,
  });
  c.setAAD(aad, { plaintextLength: plain.length });
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([ct, c.getAuthTag()]));
}

function encryptCtr(plain: Buffer, key = KEY, from = FROM, id = PACKET_ID): Uint8Array {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(id >>> 0, 0);
  nonce.writeUInt32LE(from >>> 0, 8);
  const c = createCipheriv('aes-128-ctr', key, nonce);
  return new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
}

function row(id: number, name: string, useAead: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    psk: KEY.toString('base64'),
    pskLength: 16,
    isEnabled: true,
    enforceNameValidation: false,
    useAead,
    sortOrder: id,
    ...extra,
  };
}

// Only the exact plaintext decodes, so garbage from a wrong mode is a miss.
const mockDataType = {
  decode: vi.fn((data: Buffer) => {
    if (!Buffer.from(data).equals(PLAINTEXT)) throw new Error('invalid wire');
    return { portnum: 1, payload: Buffer.from('test') };
  }),
};

describe('ChannelDecryptionService — AEAD channels (#5248)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelDecryptionService.invalidateCache();
    channelDecryptionService.setEnabled(true);
    (protobufLoader.getProtobufRoot as Mock).mockReturnValue({ lookupType: () => mockDataType });
  });

  const useRows = (rows: unknown[]) =>
    (databaseService.channelDatabase.getEnabledAsync as Mock).mockResolvedValue(rows);

  it('Node AES-CCM matches the RFC 3610 vector the firmware tests against (Packet Vector #1)', () => {
    const key = Buffer.from('C0C1C2C3C4C5C6C7C8C9CACBCCCDCECF', 'hex');
    const nonce = Buffer.from('00000003020100A0A1A2A3A4A5', 'hex');
    const aad = Buffer.from('0001020304050607', 'hex');
    const crypt = Buffer.from('588C979A61C663D2F066D0C2C0F989806D5F6B61DAC384', 'hex');
    const d = createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: 8 });
    d.setAuthTag(Buffer.from('17E8D12CFDF926E0', 'hex'));
    d.setAAD(aad, { plaintextLength: crypt.length });
    const plain = d.update(crypt);
    d.final();
    expect(plain.toString('hex').toUpperCase()).toBe('08090A0B0C0D0E0F101112131415161718191A1B1C1D1E');
  });

  it('computes the AEAD channel hash as the plain hash ^ 0xAE', () => {
    const plain = computeChannelHash('LongFast', KEY);
    expect(computeChannelHash('LongFast', KEY, true)).toBe(plain ^ 0xae);
    expect(computeChannelHash('LongFast', KEY, false)).toBe(plain);
  });

  it('decrypts an AEAD packet with an AEAD row', async () => {
    useRows([row(1, 'Secure', true)]);
    const r = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, undefined, TO);
    expect(r.success).toBe(true);
    expect(r.channelDatabaseId).toBe(1);
    expect(r.portnum).toBe(1);
  });

  it('works with a 32-byte key (AES-256-CCM)', async () => {
    const key256 = Buffer.alloc(32, 7);
    useRows([row(1, 'Secure', true, { psk: key256.toString('base64'), pskLength: 32 })]);
    const r = await channelDecryptionService.tryDecrypt(
      encryptCcm(PLAINTEXT, key256),
      PACKET_ID,
      FROM,
      undefined,
      TO,
    );
    expect(r.success).toBe(true);
  });

  it('misses when the destination differs (it is authenticated)', async () => {
    useRows([row(1, 'Secure', true)]);
    const r = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, undefined, 0x0000aaaa);
    expect(r.success).toBe(false);
  });

  it('misses on a tampered tag', async () => {
    useRows([row(1, 'Secure', true)]);
    const packet = encryptCcm(PLAINTEXT);
    packet[packet.length - 1] ^= 0xff;
    const r = await channelDecryptionService.tryDecrypt(packet, PACKET_ID, FROM, undefined, TO);
    expect(r.success).toBe(false);
  });

  it('skips an AEAD row when the caller has no destination', async () => {
    useRows([row(1, 'Secure', true)]);
    const r = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM);
    expect(r.success).toBe(false);
  });

  it('never tries CTR on an AEAD row (no fallback, as in firmware)', async () => {
    useRows([row(1, 'Secure', true)]);
    const r = await channelDecryptionService.tryDecrypt(encryptCtr(PLAINTEXT), PACKET_ID, FROM, undefined, TO);
    expect(r.success).toBe(false);
  });

  it('a plain row does not open an AEAD packet', async () => {
    useRows([row(1, 'Secure', false)]);
    const r = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, undefined, TO);
    expect(r.success).toBe(false);
  });

  it('attributes to the AEAD row when a plain row shares the name and key', async () => {
    useRows([row(1, 'Secure', false), row(2, 'Secure', true)]);
    const hash = computeChannelHash('Secure', KEY, true);
    const r = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, hash, TO);
    expect(r.success).toBe(true);
    expect(r.channelDatabaseId).toBe(2);
  });

  it('name validation on an AEAD row matches the ^ 0xAE hash', async () => {
    useRows([row(1, 'Secure', true, { enforceNameValidation: true })]);
    const plainHash = computeChannelHash('Secure', KEY);
    const miss = await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, plainHash, TO);
    expect(miss.success).toBe(false);
    const hit = await channelDecryptionService.tryDecrypt(
      encryptCcm(PLAINTEXT),
      PACKET_ID,
      FROM,
      plainHash ^ 0xae,
      TO,
    );
    expect(hit.success).toBe(true);
  });

  it('peekPortnum and tryDecryptWithChannel take the AEAD path too', async () => {
    useRows([row(1, 'Secure', true)]);
    await channelDecryptionService.refreshChannelCache();
    expect(channelDecryptionService.peekPortnum(encryptCcm(PLAINTEXT), PACKET_ID, FROM, undefined, TO)).toBe(1);
    const r = await channelDecryptionService.tryDecryptWithChannel(encryptCcm(PLAINTEXT), PACKET_ID, FROM, 1, TO);
    expect(r.success).toBe(true);
  });

  it('logs a debug hint when a packet carries a known plain channel hash ^ 0xAE', async () => {
    const debug = vi.spyOn(logger, 'debug');
    useRows([row(1, 'Secure', false)]);
    const aeadHash = computeChannelHash('Secure', KEY) ^ 0xae;
    await channelDecryptionService.tryDecrypt(encryptCcm(PLAINTEXT), PACKET_ID, FROM, aeadHash, TO);
    expect(debug.mock.calls.some((c) => String(c[0]).includes('looks AEAD-enabled upstream'))).toBe(true);
  });
});
