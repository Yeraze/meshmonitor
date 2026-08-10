/**
 * Meshtastic security-key helpers (#4632).
 *
 * A Meshtastic node's identity is an X25519 (Curve25519) keypair. The private
 * key stored in `Config.SecurityConfig.private_key` is the raw 32-byte scalar;
 * the public key is its X25519 base-point multiple. The firmware does NOT
 * re-derive the public key when you write a private key over the admin channel
 * — it stores exactly the pair you send — so pasting a private key while
 * preserving the OLD public key would leave the node advertising a key that no
 * longer matches its secret, silently breaking PKI DMs to it.
 *
 * These helpers validate a pasted key and derive the matching public key so the
 * pair is always written consistently.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  MESHTASTIC_KEY_BYTES,
  isValidMeshtasticKey,
  normalizeMeshtasticKey,
} from '../../utils/meshtasticKeyFormat.js';

// Format validation is shared with the client so the two can't drift.
export { MESHTASTIC_KEY_BYTES, isValidMeshtasticKey, normalizeMeshtasticKey };

/** Decode a base64 key to its 32 raw bytes, or null if it is not a valid key. */
export function decodeKey(value: string): Buffer | null {
  if (!isValidMeshtasticKey(value)) return null;
  return Buffer.from(normalizeMeshtasticKey(value), 'base64');
}

/**
 * Derive the base64 public key that matches a base64 private key.
 *
 * Wraps the raw scalar in the fixed PKCS#8 prefix for X25519 so Node's crypto
 * will import it, then exports the SPKI public key and strips to its trailing
 * 32 raw bytes. Verified against Node's own `generateKeyPairSync('x25519')`.
 *
 * @throws if the private key is not a valid 32-byte base64 key.
 */
export function derivePublicKey(privateKeyBase64: string): string {
  const raw = decodeKey(privateKeyBase64);
  if (!raw) {
    throw new Error('Invalid private key: expected base64 of 32 bytes');
  }
  // PKCS#8 header for an X25519 private key followed by the 32-byte scalar.
  const pkcs8Prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, raw]);
  const keyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  // createPublicKey accepts a private KeyObject at runtime, but this @types/node
  // version's overload set omits it — cast to the parameter's own type rather
  // than `any` so the rest of the call stays type-checked.
  const publicKey = createPublicKey(keyObject as unknown as Parameters<typeof createPublicKey>[0]);
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - MESHTASTIC_KEY_BYTES).toString('base64');
}
