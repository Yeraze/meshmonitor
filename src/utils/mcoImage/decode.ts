import { detectMcoImage, MCO_IMAGE_MAX_DIMENSION, MCO_IMAGE_MAX_PIXELS } from './detect.js';
import type { DecodedMcoImage } from './types.js';
import { decodeV3Text } from './v3/decoder.js';
import { McoImageV3CodecError } from './v3/errors.js';
import { v3ToRgba } from './v3/rgba.js';

const CACHE_LIMIT = 32;
const cache = new Map<string, DecodedMcoImage | null>();

function remember(key: string, value: DecodedMcoImage | null): DecodedMcoImage | null {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

/**
 * Never throws. Re-checks detectMcoImage, decodes, enforces MAX_DIMENSION/MAX_PIXELS,
 * converts to RGBA. LRU-memoised by payload (32 entries, failures cached as null).
 */
export function decodeMcoImageText(text: string): DecodedMcoImage | null {
  const candidate = detectMcoImage(text);
  if (!candidate) return null;
  const key = candidate.payload;
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null;
    // Re-insert to mark as most recently used.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  try {
    const v3 = decodeV3Text(candidate.payload);
    if (
      v3.width > MCO_IMAGE_MAX_DIMENSION ||
      v3.height > MCO_IMAGE_MAX_DIMENSION ||
      v3.width * v3.height > MCO_IMAGE_MAX_PIXELS
    ) {
      return remember(key, null);
    }
    return remember(key, { format: 'im3', width: v3.width, height: v3.height, rgba: v3ToRgba(v3) });
  } catch (err) {
    if (!(err instanceof McoImageV3CodecError)) {
      console.debug('[mcoImage] unexpected decode failure', err);
    }
    return remember(key, null);
  }
}
