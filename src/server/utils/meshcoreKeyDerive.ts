/**
 * Public key from a MeshCore (orlp-format, 64-byte expanded) Ed25519 private
 * key, so a key restore can pin the exact key the radio will report (P9 #6255).
 * Returns null on any bad input; callers then fall back to an unpinned
 * announcement.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

export function derivePublicKeyFromPrivateHex(privHex: string): string | null {
  try {
    if (!/^[0-9a-fA-F]{128}$/.test(privHex)) return null;
    const scalarBytes = Buffer.from(privHex.slice(0, 64), 'hex');
    let n = 0n;
    for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(scalarBytes[i]);
    n %= ed25519.Point.Fn.ORDER;
    if (n === 0n) return null;
    return ed25519.Point.BASE.multiply(n).toHex();
  } catch {
    return null;
  }
}
