/**
 * PKI DM decryption tests.
 *
 * These exercise a full encrypt→decrypt round trip using the exact Meshtastic
 * PKC scheme (X25519 → SHA-256 → AES-256-CCM/8) so the decryptor is validated
 * against an independently-constructed ciphertext, plus the ECDH symmetry that
 * makes sender and receiver derive the same key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKeyPairSync,
  createCipheriv,
  createPublicKey,
  createPrivateKey,
  KeyObject,
} from 'crypto';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';
import {
  pkiDecryptionService,
  derivePkiAesKey,
  buildPkiNonce,
} from './pkiDecryptionService.js';

/** Extract the raw 32-byte X25519 keys from a Node keypair. */
function rawKeys(): { priv: Buffer; pub: Buffer; privObj: KeyObject; pubObj: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  // SPKI DER: 12-byte prefix + 32-byte key; PKCS8 DER: 16-byte prefix + 32-byte key.
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { priv, pub, privObj: privateKey, pubObj: publicKey };
}

/** Encode a meshtastic.Data protobuf for a text message. */
function encodeTextData(text: string): Buffer {
  const root = getProtobufRoot()!;
  const Data = root.lookupType('meshtastic.Data');
  const msg = Data.create({ portnum: 1 /* TEXT_MESSAGE_APP */, payload: Buffer.from(text, 'utf8') });
  return Buffer.from(Data.encode(msg).finish());
}

/**
 * Encrypt a Data plaintext exactly as the firmware does, producing the on-wire
 * `encrypted` blob: [ciphertext][8B MAC][4B extraNonce LE].
 */
function encryptPkiDm(
  senderPriv32: Buffer,
  recipientPub32: Buffer,
  packetId: number,
  fromNode: number,
  extraNonce: number,
  plaintext: Buffer,
): Buffer {
  const aesKey = derivePkiAesKey(senderPriv32, recipientPub32);
  const nonce = buildPkiNonce(packetId, fromNode, extraNonce);
  const cipher = createCipheriv('aes-256-ccm', aesKey, nonce, {
    authTagLength: 8,
  });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = cipher.getAuthTag();
  const extra = Buffer.alloc(4);
  extra.writeUInt32LE(extraNonce >>> 0, 0);
  return Buffer.concat([ct, mac, extra]);
}

describe('pkiDecryptionService', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('derives identical AES keys from both sides (ECDH symmetry + SHA-256)', () => {
    const sender = rawKeys();
    const recipient = rawKeys();
    const keyFromRecipient = derivePkiAesKey(recipient.priv, sender.pub);
    const keyFromSender = derivePkiAesKey(sender.priv, recipient.pub);
    expect(keyFromRecipient.equals(keyFromSender)).toBe(true);
    expect(keyFromRecipient.length).toBe(32);
  });

  it('round-trips a text DM: encrypt with sender keys → decrypt with recipient key', () => {
    const sender = rawKeys();
    const recipient = rawKeys();
    const packetId = 0x1a2b3c4d;
    const fromNode = 0xaabbccdd;
    const extraNonce = 0x11223344;
    const plaintext = encodeTextData('hello over PKI');

    const blob = encryptPkiDm(sender.priv, recipient.pub, packetId, fromNode, extraNonce, plaintext);

    const result = pkiDecryptionService.tryDecryptDirectMessage(
      recipient.priv,
      sender.pub,
      packetId,
      fromNode,
      blob,
    );
    expect(result.success).toBe(true);
    expect(result.portnum).toBe(1);
    expect(Buffer.from(result.payload!).toString('utf8')).toBe('hello over PKI');
  });

  it('fails (MAC mismatch) with the wrong sender public key', () => {
    const sender = rawKeys();
    const wrong = rawKeys();
    const recipient = rawKeys();
    const blob = encryptPkiDm(sender.priv, recipient.pub, 1, 2, 3, encodeTextData('secret'));
    const result = pkiDecryptionService.tryDecryptDirectMessage(recipient.priv, wrong.pub, 1, 2, blob);
    expect(result.success).toBe(false);
  });

  it('fails (MAC mismatch) when packetId/fromNode in the nonce differ', () => {
    const sender = rawKeys();
    const recipient = rawKeys();
    const blob = encryptPkiDm(sender.priv, recipient.pub, 100, 200, 5, encodeTextData('x'));
    // Tampered nonce inputs => CCM auth fails.
    const result = pkiDecryptionService.tryDecryptDirectMessage(recipient.priv, sender.pub, 101, 200, blob);
    expect(result.success).toBe(false);
  });

  it('rejects malformed key sizes and short blobs without throwing', () => {
    const ok = rawKeys();
    expect(pkiDecryptionService.tryDecryptDirectMessage(Buffer.alloc(10), ok.pub, 1, 1, Buffer.alloc(40)).success).toBe(false);
    expect(pkiDecryptionService.tryDecryptDirectMessage(ok.priv, Buffer.alloc(3), 1, 1, Buffer.alloc(40)).success).toBe(false);
    expect(pkiDecryptionService.tryDecryptDirectMessage(ok.priv, ok.pub, 1, 1, Buffer.alloc(8)).success).toBe(false);
  });

  it('builds a 13-byte CCM nonce with the documented layout', () => {
    const nonce = buildPkiNonce(0x04030201, 0x08070605, 0x0c0b0a09);
    expect(nonce.length).toBe(13);
    // packetId LE (4) + zero high (4) + fromNode LE (4) + low byte of extraNonce (1)
    expect([...nonce]).toEqual([
      0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x05, 0x06, 0x07, 0x08, 0x09,
    ]);
  });
});
