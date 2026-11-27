/**
 * Browser-side image decode for the MCOimg compose dialog (spec D3 step 1).
 * The only browser-dependent step of the pipeline: the result is a small RGBA
 * source (longest side at most 512 px) that the workers process deterministically.
 */
import type { RgbaImage } from '../../../utils/mcoImage/compose/types.js';

export const MCO_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const MCO_SOURCE_MAX_SIDE = 512;

export type McoImageFileErrorKind = 'type' | 'size' | 'decode';

export class McoImageFileError extends Error {
  readonly kind: McoImageFileErrorKind;
  constructor(kind: McoImageFileErrorKind, message?: string) {
    super(message ?? `MCOimg source file rejected: ${kind}`);
    this.name = 'McoImageFileError';
    this.kind = kind;
  }
}

const MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const EXTENSION = /\.(png|jpe?g)$/i;

/** Throws `McoImageFileError` (`type` or `size`) when the file is not an acceptable source. */
export function validateImageFile(file: File): void {
  if (!MIME_TYPES.has(file.type) || !EXTENSION.test(file.name)) throw new McoImageFileError('type');
  if (file.size > MCO_SOURCE_MAX_BYTES) throw new McoImageFileError('size');
}

interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function loadViaBitmap(file: File): Promise<Drawable> {
  const bitmap = await createImageBitmap(file); // EXIF orientation applied by default
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

function loadViaImgElement(file: File): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const release = () => URL.revokeObjectURL(url);
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release });
    img.onerror = () => {
      release();
      reject(new McoImageFileError('decode'));
    };
    img.src = url;
  });
}

async function load(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await loadViaBitmap(file);
    } catch {
      // fall through to the <img> path
    }
  }
  return loadViaImgElement(file);
}

/**
 * Decode a PNG or JPEG file into an RGBA image whose longest side is at most `maxSide`.
 * Rejects with `McoImageFileError` of kind `type`, `size` or `decode`.
 */
export async function decodeImageFile(file: File, maxSide: number = MCO_SOURCE_MAX_SIDE): Promise<RgbaImage> {
  validateImageFile(file);
  let drawable: Drawable;
  try {
    drawable = await load(file);
  } catch (err) {
    throw err instanceof McoImageFileError ? err : new McoImageFileError('decode');
  }
  try {
    if (!(drawable.width > 0 && drawable.height > 0)) throw new McoImageFileError('decode');
    const scale = Math.min(1, maxSide / Math.max(drawable.width, drawable.height));
    const width = Math.max(1, Math.round(drawable.width * scale));
    const height = Math.max(1, Math.round(drawable.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new McoImageFileError('decode');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable.source, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height);
    return { width, height, rgba: new Uint8ClampedArray(data.data) };
  } catch (err) {
    throw err instanceof McoImageFileError ? err : new McoImageFileError('decode');
  } finally {
    drawable.release();
  }
}
