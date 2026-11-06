/**
 * MeshCore DIRECT-MESSAGE (TXT_MSG / PAYLOAD_TYPE_TXT_MSG 0x02) self-echo
 * decryption (#6195, in service of #6194).
 *
 * A MeshCore DM is PKI-encrypted: the sender derives a symmetric secret by
 * ECDH between its own Ed25519 identity key and the recipient's Ed25519 public
 * key, then `encryptThenMAC`s the body with it. When a nearby repeater
 * re-floods one of OUR DMs, our own device hears it back as an inbound TXT_MSG.
 * #6194 attributes that echo to the message we sent by the 1-byte src/dest hash
 * prefixes alone, and MUST skip when two pending sends collide on those bytes
 * because it cannot tell them apart. This module gives the server the one extra
 * tool needed to break that tie: with our OWN device private key (captured and
 * stored per #6195) it can derive the per-peer DM secret and decrypt the echoed
 * body, then confirm which pending send it actually was.
 *
 * ── Honesty note on firmware-exactness ──────────────────────────────────────
 * The symmetric scheme below is the SAME `encryptThenMAC` used on the group
 * path (verified against firmware in meshcoreGroupEcho.ts); only the secret
 * differs. The ECDH derivation is the orlp `ed25519_key_exchange` (convert both
 * keys Ed25519 → Curve25519, then X25519) that MeshCore uses. We validate the
 * X25519 primitive against the RFC 7748 vector and prove commutativity in
 * tests, but we have NOT validated the end-to-end decrypt against a real
 * captured DM (we hold no such fixture). The DM plaintext header layout
 * (timestamp + a flags/attempt byte, then the text) is taken from the group
 * layout; a direct message may frame it differently. This is acceptable because
 * the one consumer (findDmEchoMatch) degrades safely: a wrong or empty decrypt
 * simply fails to disambiguate and the #6194 heuristic bails exactly as it does
 * today. An imperfect decrypt NEVER corrupts data — it only forgoes a
 * disambiguation it could not confidently make.
 *
 * Server-only (Node `crypto` + @noble/curves). Every function is defensive and
 * returns null on ANY failure; neither throws, so both are safe on the hot
 * inbound-packet path.
 */
import { createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { x25519, edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { hexToBytes } from '../../utils/meshcorePacketDecode.js';
import { secretToKeys, AES_BLOCK_SIZE, CIPHER_MAC_SIZE } from './meshcoreGroupEcho.js';

/** Plaintext header: timestamp(4 LE) + flags/attempt(1), then the text. */
const DM_HEADER_SIZE = 5;
/** An Ed25519 scalar / X25519 private scalar is 32 bytes. */
const SCALAR_BYTES = 32;
/** An Ed25519 public key is 32 bytes (64 hex). */
const ED25519_PUBKEY_BYTES = 32;

/**
 * Derive the MeshCore DM shared secret between OUR device and a peer.
 *
 * MeshCore identity keys are Ed25519; the DM shared secret is X25519 over the
 * Curve25519 (Montgomery) forms of both keys — orlp's `ed25519_key_exchange`.
 *
 * @param ourPrivHex orlp private-key hex. The first 32 bytes are the (already
 *                   clamped) X25519 scalar; a 64-byte orlp key or a bare 32-byte
 *                   scalar are both accepted.
 * @param peerPubHex the peer's 32-byte (64-hex) Ed25519 public key.
 * @returns the 32-byte X25519 shared secret, or null on any malformed input /
 *          low-order point.
 */
export function deriveMeshCoreDmSecret(ourPrivHex: string, peerPubHex: string): Buffer | null {
  try {
    if (typeof ourPrivHex !== 'string' || typeof peerPubHex !== 'string') return null;
    const priv = hexToBytes(ourPrivHex);
    const peerPub = hexToBytes(peerPubHex);
    if (priv.length < SCALAR_BYTES) return null;
    if (peerPub.length !== ED25519_PUBKEY_BYTES) return null;

    const scalar = priv.subarray(0, SCALAR_BYTES);
    // Ed25519 public key → Montgomery u-coordinate, then X25519 scalar mult.
    const montgomeryPub = edwardsToMontgomeryPub(peerPub);
    const shared = x25519.getSharedSecret(scalar, montgomeryPub);
    return Buffer.from(shared);
  } catch {
    // Malformed key, not-on-curve point, or an all-zero (low-order) shared
    // secret — @noble throws on the last one, which we treat as "no secret".
    return null;
  }
}

export interface DecodedDmText {
  /** Firmware send-time timestamp (unix seconds, LE) recovered from plaintext. */
  timestamp: number;
  /** The recovered message text (no sender-name prefix, unlike group text). */
  text: string;
}

/**
 * MAC-verify and AES-128-ECB decrypt a DM TXT_MSG encrypted payload
 * (`[MAC:2][ciphertext]` hex, i.e. the bytes after the plaintext
 * `[dest_hash:1][src_hash:1]` prefix) with a derived 32-byte DM secret. Returns
 * the recovered `{ timestamp, text }` or null on ANY failure (MAC mismatch,
 * malformed structure, short plaintext). NEVER throws.
 *
 * Uses the same `encryptThenMAC` scheme as the group path: AES-128-ECB over
 * `secret[0:16]`, HMAC-SHA256 over the whole (zero-padded-to-32) secret,
 * 2-byte MAC, firmware zero-padding (no PKCS).
 */
export function tryDecodeDmTextPayload(
  encryptedHex: string | null | undefined,
  secret: Uint8Array,
): DecodedDmText | null {
  try {
    if (!encryptedHex) return null;
    const keys = secretToKeys(secret);
    if (!keys) return null;

    const bytes = hexToBytes(encryptedHex);
    if (bytes.length < CIPHER_MAC_SIZE + AES_BLOCK_SIZE) return null;

    const mac = bytes.subarray(0, CIPHER_MAC_SIZE);
    const ciphertext = bytes.subarray(CIPHER_MAC_SIZE);
    if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) return null;

    // MAC verify: HMAC-SHA256(secret32, ciphertext)[0:2]. This is what lets us
    // reject a wrong peer's key — a mismatched secret fails here and returns
    // null, so only the ACTUAL recipient's key decodes.
    const expected = createHmac('sha256', keys.hmacKey).update(Buffer.from(ciphertext)).digest();
    if (expected[0] !== mac[0] || expected[1] !== mac[1]) return null;

    // AES-128-ECB decrypt. Firmware zero-pads (not PKCS), so no auto-padding.
    const decipher = createDecipheriv('aes-128-ecb', keys.aesKey, null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
    if (plain.length < DM_HEADER_SIZE) return null;

    const timestamp = plain.readUInt32LE(0);
    // Text is NUL-terminated inside the buffer (or ends at the zero padding).
    let end = plain.indexOf(0, DM_HEADER_SIZE);
    if (end < 0) end = plain.length;
    const text = plain.subarray(DM_HEADER_SIZE, end).toString('utf8');
    return { timestamp, text };
  } catch {
    return null;
  }
}

/**
 * Build a DM TXT_MSG encrypted payload (`[MAC:2][ciphertext]` hex) — the exact
 * inverse of {@link tryDecodeDmTextPayload}, used to construct test fixtures
 * so the decode path is validated end-to-end. Returns lowercase hex.
 */
export function encodeDmTextPayload(
  secret: Uint8Array,
  text: string,
  timestamp: number = Math.floor(Date.now() / 1000),
  flags = 0x00,
): string {
  const keys = secretToKeys(secret);
  if (!keys) throw new Error('DM secret too short');

  const bodyBytes = Buffer.from(text, 'utf8');
  const rawLen = DM_HEADER_SIZE + bodyBytes.length;
  const paddedLen = Math.ceil(rawLen / AES_BLOCK_SIZE) * AES_BLOCK_SIZE;
  const plain = Buffer.alloc(paddedLen); // zero-filled → zero padding
  plain.writeUInt32LE(timestamp >>> 0, 0);
  plain[4] = flags & 0xff;
  bodyBytes.copy(plain, DM_HEADER_SIZE);

  const cipher = createCipheriv('aes-128-ecb', keys.aesKey, null);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);

  const mac = createHmac('sha256', keys.hmacKey).update(ciphertext).digest();
  return Buffer.concat([mac.subarray(0, CIPHER_MAC_SIZE), ciphertext]).toString('hex');
}
