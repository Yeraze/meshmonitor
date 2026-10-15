/**
 * Channel key helpers shared by the Meshtastic and MeshCore channel editors
 * (#5829). Meshtastic writes keys as base64; MeshCore shows them as hex.
 */

export type ChannelKeyFormat = 'base64' | 'hex';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** A fresh random key of `byteLength` bytes, in `format`. */
export function generateChannelKey(byteLength: number, format: ChannelKeyFormat): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return format === 'hex' ? bytesToHex(bytes) : bytesToBase64(bytes);
}

/**
 * How many bytes `value` decodes to, or null when it is not valid `format`.
 * Spaces are ignored. An empty value is 0 bytes.
 */
export function channelKeyByteLength(value: string, format: ChannelKeyFormat): number | null {
  const clean = value.replace(/\s+/g, '');
  if (clean === '') return 0;
  if (format === 'hex') {
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return null;
    return clean.length / 2;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  try {
    return atob(clean).length;
  } catch {
    return null;
  }
}

/** True when `value` is valid `format` and decodes to one of `allowedBytes`. */
export function isValidChannelKey(
  value: string,
  format: ChannelKeyFormat,
  allowedBytes: readonly number[],
): boolean {
  const len = channelKeyByteLength(value, format);
  return len !== null && allowedBytes.includes(len);
}

export function base64ToHex(b64: string | null | undefined): string {
  if (!b64) return '';
  try {
    const bin = atob(b64);
    let out = '';
    for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return out;
  } catch {
    return '';
  }
}

export function hexToBase64(hex: string): string {
  const clean = hex.replace(/\s+/g, '').toLowerCase();
  if (clean.length % 2 !== 0) throw new Error('odd hex length');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const v = parseInt(clean.substring(i, i + 2), 16);
    if (Number.isNaN(v)) throw new Error('invalid hex');
    bytes[i / 2] = v;
  }
  return bytesToBase64(bytes);
}
