/**
 * PKI Direct Message decryption (Meshtastic Curve25519 PKC).
 *
 * Meshtastic encrypts unicast DMs to a node with the recipient's public key.
 * MeshMonitor can decrypt them server-side when it holds the recipient (local
 * node)'s private key — extracted from the device's SecurityConfig — so that a
 * DM that arrived on one radio source can be surfaced in the unified view.
 *
 * Byte-exact scheme (firmware `src/mesh/CryptoEngine.cpp`):
 *   shared  = X25519(localPrivate, senderPublic)        // raw 32B ECDH
 *   aesKey  = SHA-256(shared)                            // 32B  (NOT the raw ECDH!)
 *   blob    = encrypted = [ciphertext][8B CCM-MAC][4B extraNonce LE]   // 12B overhead
 *   nonce   = [packetId u64 LE (8)][fromNode u32 LE (4)][extraNonce low byte (1)]  // 13B CCM nonce
 *   plain   = AES-256-CCM-decrypt(aesKey, nonce, ciphertext, mac, authTagLen=8)    // no AAD
 * The plaintext is a `meshtastic.Data` protobuf (same as a node-decoded packet).
 *
 * Security note: this requires the local node's private key. It is only ever
 * used in memory for decryption here; storage/consent is handled by the caller
 * (see the per-source PKI key store + the `pkiDmDecryptionEnabled` setting).
 */
import { createHash, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, KeyObject } from 'crypto';
import { getProtobufRoot } from '../protobufLoader.js';
import { logger } from '../../utils/logger.js';

/** Wire overhead appended after the ciphertext: 8B MAC + 4B extraNonce. */
const PKC_OVERHEAD = 12;
const MAC_LEN = 8;
const KEY_LEN = 32;

/** DER prefixes that wrap a raw 32-byte X25519 key for Node's KeyObject API. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // private
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // public

export interface PkiDecryptResult {
  success: boolean;
  portnum?: number;
  payload?: Uint8Array;
  emoji?: number;
  replyId?: number;
  bitfield?: number;
  error?: string;
}

function rawPrivateToKeyObject(raw32: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw32]),
    format: 'der',
    type: 'pkcs8',
  });
}

function rawPublicToKeyObject(raw32: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw32]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Derive the AES-256 key for a PKI DM: SHA-256 of the raw X25519 ECDH secret.
 * Exposed for testing (the encrypt side of the round-trip uses the same key).
 */
export function derivePkiAesKey(localPrivate32: Buffer, remotePublic32: Buffer): Buffer {
  const shared = diffieHellman({
    privateKey: rawPrivateToKeyObject(localPrivate32),
    publicKey: rawPublicToKeyObject(remotePublic32),
  });
  return createHash('sha256').update(shared).digest();
}

/**
 * Build the 13-byte AES-CCM nonce. The firmware lays it out in a 16-byte buffer
 * ([packetId u64 LE][fromNode u32 LE][extraNonce u32 LE]) and hands CCM the
 * first 13 bytes — so only the LOW byte of extraNonce participates. Exposed for
 * testing.
 */
export function buildPkiNonce(packetId: number, fromNode: number, extraNonce: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(packetId >>> 0, 0);
  buf.writeUInt32LE(0, 4); // packetId high 32 bits are always 0 (fixed32 on the wire)
  buf.writeUInt32LE(fromNode >>> 0, 8);
  buf.writeUInt32LE(extraNonce >>> 0, 12);
  return buf.subarray(0, 13);
}

class PkiDecryptionService {
  /**
   * Attempt to decrypt a PKI-encrypted direct message.
   *
   * @param localPrivateKey  the recipient (local node)'s 32-byte X25519 private key
   * @param senderPublicKey  the sender node's 32-byte X25519 public key (from NodeDB)
   * @param packetId         MeshPacket.id (fixed32)
   * @param fromNode         MeshPacket.from (sender node num)
   * @param encryptedBlob    MeshPacket.encrypted ([ciphertext][8B mac][4B extraNonce])
   */
  tryDecryptDirectMessage(
    localPrivateKey: Uint8Array,
    senderPublicKey: Uint8Array,
    packetId: number,
    fromNode: number,
    encryptedBlob: Uint8Array,
  ): PkiDecryptResult {
    if (!localPrivateKey || localPrivateKey.length !== KEY_LEN) {
      return { success: false, error: 'Local private key must be 32 bytes' };
    }
    if (!senderPublicKey || senderPublicKey.length !== KEY_LEN) {
      return { success: false, error: 'Sender public key must be 32 bytes' };
    }
    const blob = Buffer.from(encryptedBlob);
    if (blob.length <= PKC_OVERHEAD) {
      return { success: false, error: 'Blob too short to be a PKI DM' };
    }

    try {
      const aesKey = derivePkiAesKey(Buffer.from(localPrivateKey), Buffer.from(senderPublicKey));

      const ciphertext = blob.subarray(0, blob.length - PKC_OVERHEAD);
      const mac = blob.subarray(blob.length - PKC_OVERHEAD, blob.length - 4);
      const extraNonce = blob.readUInt32LE(blob.length - 4);
      const nonce = buildPkiNonce(packetId, fromNode, extraNonce);

      const decipher = createDecipheriv('aes-256-ccm', aesKey, nonce, { authTagLength: MAC_LEN });
      decipher.setAuthTag(mac);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      return this.decodeData(plaintext);
    } catch (_err) {
      // A MAC failure (wrong key / not actually for us) throws on final() — expected.
      return { success: false, error: 'PKI decryption failed (MAC mismatch or wrong key)' };
    }
  }

  /** Decode the decrypted plaintext as a `meshtastic.Data` protobuf. */
  private decodeData(plaintext: Buffer): PkiDecryptResult {
    const root = getProtobufRoot();
    if (!root) {
      return { success: false, error: 'Protobuf root not loaded' };
    }
    try {
      const DataType = root.lookupType('meshtastic.Data');
      const decoded = DataType.decode(plaintext) as any;
      const portnum = decoded.portnum ?? 0;
      // Sanity: Meshtastic portnums are within a small range; a wrong-key decrypt
      // that somehow passed the MAC (astronomically unlikely) would likely fail here.
      if (typeof portnum !== 'number' || portnum < 0 || portnum > 511) {
        return { success: false, error: `Implausible portnum ${portnum}` };
      }
      return {
        success: true,
        portnum,
        payload: decoded.payload,
        emoji: decoded.emoji,
        replyId: decoded.replyId,
        bitfield: decoded.bitfield,
      };
    } catch (err) {
      logger.debug('PKI plaintext was not a valid Data protobuf:', err);
      return { success: false, error: 'Decrypted bytes are not a valid Data protobuf' };
    }
  }
}

export const pkiDecryptionService = new PkiDecryptionService();
export default pkiDecryptionService;
