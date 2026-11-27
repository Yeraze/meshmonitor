import { detectMcoImage, MCO_IMAGE_MAX_DIMENSION, MCO_IMAGE_MAX_PIXELS } from './detect.js';
import type { DecodedMcoImage } from './types.js';
import { decodeV3Text } from './v3/decoder.js';
import { McoImageV3CodecError } from './v3/errors.js';
import { v3ToRgba } from './v3/rgba.js';
import { collectV4Captions } from './v4/captions.js';
import { decodeV4Text } from './v4/decoder.js';
import {
  McoImageV4CodecError,
  McoImageV4InvalidPayloadError,
  McoImageV4TooLargeError,
  McoImageV4UnsupportedFormatError,
} from './v4/errors.js';

export { paintMcoImageV4 } from './v4/paint.js';
export type { McoPaintOptions } from './v4/paint.js';

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

function decodeIm4(payload: string): DecodedMcoImage | null {
  try {
    const { document } = decodeV4Text(payload);
    if (
      document.width > MCO_IMAGE_MAX_DIMENSION ||
      document.height > MCO_IMAGE_MAX_DIMENSION ||
      document.width * document.height > MCO_IMAGE_MAX_PIXELS
    ) {
      return null;
    }
    return {
      format: 'im4',
      width: document.width,
      height: document.height,
      document,
      captions: collectV4Captions(document),
    };
  } catch (err) {
    // Damaged, unsupported (newer feature) and over-the-limits images all show as text.
    if (err instanceof McoImageV4TooLargeError) {
      console.debug('[mcoImage] im4 too complex to draw safely');
    } else if (err instanceof McoImageV4UnsupportedFormatError) {
      console.debug('[mcoImage] im4 uses an unsupported feature');
    } else if (err instanceof McoImageV4InvalidPayloadError) {
      console.debug('[mcoImage] im4 payload invalid');
    } else if (!(err instanceof McoImageV3CodecError) && !(err instanceof McoImageV4CodecError)) {
      console.debug('[mcoImage] unexpected decode failure', err);
    }
    return null;
  }
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
  if (candidate.format === 'im4') return remember(key, decodeIm4(candidate.payload));
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
