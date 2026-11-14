/**
 * Crypto for MQTT-native send (#4305): the encrypt side of the decrypt code
 * MeshMonitor already has, so every packet we build round-trips through the
 * repo's own MQTT channel decrypt and PKI decrypt.
 *
 * - Channel packets: AES-CTR with the expanded channel PSK and the firmware
 *   nonce (packetId LE64 | fromNode LE32 | 0), or AES-CCM on an AEAD channel
 *   (firmware 2.8.1+: 13-byte nonce, AAD = from|to, 12-byte tag appended).
 *   Mirrors `channelDecryptionService`.
 * - PKI DMs: AES-256-CCM keyed by sha256(X25519(ourPriv, theirPub)), nonce
 *   from (packetId, fromNode, extraNonce), 8-byte tag, blob =
 *   ciphertext | tag | extraNonce LE32. Mirrors `pkiDecryptionService`.
 * - Identity: an X25519 keypair whose node number is crc32(publicKey), the
 *   firmware 2.8 derivation (`nodeNumFromPublicKey`).
 */
import crypto from 'node:crypto';
import { buildPkiNonce, derivePkiAesKey } from '../pkiDecryptionService.js';
import { AEAD_TAG_SIZE } from '../channelDecryptionService.js';
import { nodeNumFromPublicKey } from '../../../services/lowEntropyKeyService.js';
import { BROADCAST_NODE_NUM } from '../../constants/meshtastic.js';

const PKI_MAC_LEN = 8;
/** Firmware reserves node numbers below 4 (`NUM_RESERVED`); 0xFFFFFFFF is broadcast. */
const NUM_RESERVED = 4;

export interface GeneratedIdentity {
  privateKey: Buffer;
  publicKey: Buffer;
  nodeNum: number;
}

/** True for a node number a real node may hold. */
export function isUsableNodeNum(n: number): boolean {
  return Number.isInteger(n) && n >= NUM_RESERVED && n < BROADCAST_NODE_NUM;
}

/** Raw 32-byte X25519 public key for a raw 32-byte private key. */
export function x25519PublicFromPrivate(privateKey: Buffer): Buffer {
  const keyObject = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), privateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(keyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return Buffer.from(spki.subarray(spki.length - 32));
}

/**
 * Generate an X25519 keypair and its firmware-2.8 node number. Retries in the
 * (astronomically unlikely) case crc32 lands on a reserved or broadcast value.
 */
export function generateMqttNativeIdentity(): GeneratedIdentity {
  for (let attempt = 0; attempt < 16; attempt++) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const priv = Buffer.from(pkcs8.subarray(pkcs8.length - 32));
    const pub = Buffer.from(spki.subarray(spki.length - 32));
    const nodeNum = nodeNumFromPublicKey(pub.toString('base64'));
    if (nodeNum !== null && isUsableNodeNum(nodeNum)) {
      return { privateKey: priv, publicKey: pub, nodeNum };
    }
  }
  throw new Error('Could not generate a usable MQTT-native node identity');
}

/** Firmware AES-CTR nonce: packetId LE64, fromNode LE32, extraNonce LE32. */
export function buildChannelNonce(packetId: number, fromNode: number): Buffer {
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(0, 4);
  nonce.writeUInt32LE(fromNode >>> 0, 8);
  nonce.writeUInt32LE(0, 12);
  return nonce;
}

/**
 * Encrypt a serialized `meshtastic.Data` for a channel. `psk` must already be
 * expanded (16 or 32 bytes; see `expandShorthandPsk`).
 */
export function encryptChannelPayload(
  plaintext: Uint8Array,
  opts: { psk: Buffer; useAead: boolean; packetId: number; fromNode: number; toNode: number },
): Buffer {
  const { psk } = opts;
  if (psk.length !== 16 && psk.length !== 32) {
    throw new Error(`Channel PSK must be 16 or 32 bytes, got ${psk.length}`);
  }
  const nonce = buildChannelNonce(opts.packetId, opts.fromNode);
  const data = Buffer.from(plaintext);
  if (!opts.useAead) {
    const cipher = crypto.createCipheriv(psk.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr', psk, nonce);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
  const aad = Buffer.alloc(8);
  aad.writeUInt32LE(opts.fromNode >>> 0, 0);
  aad.writeUInt32LE(opts.toNode >>> 0, 4);
  const cipher = crypto.createCipheriv(psk.length === 16 ? 'aes-128-ccm' : 'aes-256-ccm', psk, nonce.subarray(0, 13), {
    authTagLength: AEAD_TAG_SIZE,
  });
  cipher.setAAD(aad, { plaintextLength: data.length });
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/**
 * Encrypt a serialized `meshtastic.Data` as a PKI direct message from
 * `fromNode` (us) to the holder of `remotePublicKey`.
 */
export function encryptPkiPayload(
  plaintext: Uint8Array,
  opts: { localPrivateKey: Buffer; remotePublicKey: Buffer; packetId: number; fromNode: number; extraNonce?: number },
): Buffer {
  if (opts.localPrivateKey.length !== 32 || opts.remotePublicKey.length !== 32) {
    throw new Error('PKI keys must be 32 bytes');
  }
  const extraNonce = opts.extraNonce ?? crypto.randomBytes(4).readUInt32LE(0);
  const key = derivePkiAesKey(opts.localPrivateKey, opts.remotePublicKey);
  const nonce = buildPkiNonce(opts.packetId, opts.fromNode, extraNonce);
  const cipher = crypto.createCipheriv('aes-256-ccm', key, nonce, { authTagLength: PKI_MAC_LEN });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const extra = Buffer.alloc(4);
  extra.writeUInt32LE(extraNonce >>> 0, 0);
  return Buffer.concat([ct, cipher.getAuthTag(), extra]);
}

/** A random, non-zero 32-bit packet id. */
export function randomPacketId(): number {
  let id = 0;
  while (id === 0) id = crypto.randomBytes(4).readUInt32LE(0);
  return id >>> 0;
}
