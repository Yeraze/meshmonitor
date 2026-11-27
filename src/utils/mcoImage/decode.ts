import type { DecodedMcoImage } from './types.js';

/**
 * Never throws. Re-checks detectMcoImage, decodes, enforces MAX_DIMENSION/MAX_PIXELS,
 * converts to RGBA. LRU-memoised by payload (32 entries, failures cached as null).
 */
export function decodeMcoImageText(_text: string): DecodedMcoImage | null {
  return null; // decoder lands in the next commit
}
