import { BASE91_ALPHABET } from './base91.js';
import type { McoImageCandidate, McoImageFormat } from './types.js';

export const MCO_IM3_PREFIX = 'im3:';
export const MCO_IM4_PREFIX = 'im4:';
/**
 * Whole trimmed text, prefix included. Meshtastic is <=233 B and MeshCore <=160 B on the
 * wire; 512 leaves headroom for MQTT and other carriers and bounds work.
 */
export const MCO_IMAGE_MAX_TEXT_LENGTH = 512;
/** Smallest app payload (0x13 + 4-byte body) is >=6 Base91 chars. */
export const MCO_IMAGE_MIN_PAYLOAD_CHARS = 6;
/** IM4 text is Base91 of the body alone; the smallest body (4 bytes) is >=5 chars. */
export const MCO_IM4_MIN_PAYLOAD_CHARS = 5;
export const MCO_IMAGE_MAX_DIMENSION = 256;
export const MCO_IMAGE_MAX_PIXELS = 65_536;

const ALPHABET_CHARS = new Set<string>(Array.from(BASE91_ALPHABET));

/**
 * Strict whole-message detection: the entire trimmed message must be one lowercase
 * `im3:` or `im4:` payload made only of basE91 characters. Does not decode.
 */
export function detectMcoImage(text: string | null | undefined): McoImageCandidate | null {
  if (!text) return null;
  const t = text.trim();
  if (t.length > MCO_IMAGE_MAX_TEXT_LENGTH) return null;
  let format: McoImageFormat;
  let prefixLength: number;
  let minChars: number;
  if (t.startsWith(MCO_IM3_PREFIX)) {
    format = 'im3';
    prefixLength = MCO_IM3_PREFIX.length;
    minChars = MCO_IMAGE_MIN_PAYLOAD_CHARS;
  } else if (t.startsWith(MCO_IM4_PREFIX)) {
    format = 'im4';
    prefixLength = MCO_IM4_PREFIX.length;
    minChars = MCO_IM4_MIN_PAYLOAD_CHARS;
  } else {
    return null;
  }
  const body = t.slice(prefixLength);
  if (body.length < minChars) return null;
  for (const ch of body) {
    if (!ALPHABET_CHARS.has(ch)) return null;
  }
  return { format, payload: t };
}

export function isMcoImageCandidate(text: string | null | undefined): boolean {
  return detectMcoImage(text) !== null;
}
