import { BASE91_ALPHABET } from './base91.js';
import type { McoImageCandidate } from './types.js';

export const MCO_IM3_PREFIX = 'im3:';
/**
 * Whole trimmed text, prefix included. Meshtastic is <=233 B and MeshCore <=160 B on the
 * wire; 512 leaves headroom for MQTT and other carriers and bounds work.
 */
export const MCO_IMAGE_MAX_TEXT_LENGTH = 512;
/** Smallest app payload (0x13 + 4-byte body) is >=6 Base91 chars. */
export const MCO_IMAGE_MIN_PAYLOAD_CHARS = 6;
export const MCO_IMAGE_MAX_DIMENSION = 256;
export const MCO_IMAGE_MAX_PIXELS = 65_536;

const ALPHABET_CHARS = new Set<string>(Array.from(BASE91_ALPHABET));

/**
 * Strict whole-message detection: the entire trimmed message must be one lowercase
 * `im3:` payload made only of basE91 characters. Does not decode.
 */
export function detectMcoImage(text: string | null | undefined): McoImageCandidate | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length > MCO_IMAGE_MAX_TEXT_LENGTH) return null;
  if (!t.startsWith(MCO_IM3_PREFIX)) return null;
  const body = t.slice(MCO_IM3_PREFIX.length);
  if (body.length < MCO_IMAGE_MIN_PAYLOAD_CHARS) return null;
  for (const ch of body) {
    if (!ALPHABET_CHARS.has(ch)) return null;
  }
  return { format: 'im3', payload: t };
}

export function isMcoImageCandidate(text: string | null | undefined): boolean {
  return detectMcoImage(text) !== null;
}
