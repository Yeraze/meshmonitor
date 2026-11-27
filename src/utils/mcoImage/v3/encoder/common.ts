/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 2178-2540
 *          (input validation, colour refs, preamble, dimension and geometry writers, scan order, bounds, local palettes, runs, sparse analysis, candidate builder, background candidates; normalizeCompressionLevel (2167-2177) is replaced by the Normal/High level argument; cache variables become the `caches` object)
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file; only types were added. Output-neutral changes are marked in comments.
 *
 * MIT License
 *
 * Copyright (c) 2025 zjs81
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Bounds, V3Image, EncodeOptions, RegionPlanCache, Candidate, BackgroundCandidate, SparseAnalysis, SparseSegment, LzToken, RegionBodyResult } from './types.js';
import type { McoImageV3BlockAlgorithmId, ScanModeId } from '../constants.js';
import { BitWriter } from './bitWriter.js';
import { localBits, geometryBits } from '../validate.js';
import { isDynamicProfile, paletteSize, globalBits, whiteIndexFor, DynamicGlobalIndices } from '../palettes.js';
import {
  CONTAINER_CONTEXT_CONTAINER_SHIFT,
  CONTAINER_CONTEXT_MASK,
  DIMENSION_MODE_EXTENDED,
  DIMENSION_MODE_MEDIUM64,
  DIMENSION_MODE_SMALL32,
  DIMENSION_MODE_SQUARE64,
  IMPLICIT_WHITE_BACKGROUND_FLAG,
  MAX_SIZE,
  MIN_SIZE,
  PaletteProfileName,
  SCAN_SHIFT,
  ScanMode,
  ScanModeName,
  TRANSPARENT_FLAG,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';
import { McoImageV3BlockAlgorithm as MCOImageV3BlockAlgorithm } from '../constants.js';
import { ImageMode, ImageModeName, MAX_EXHAUSTIVE_BACKGROUND_COLORS, MAX_EXHAUSTIVE_BACKGROUND_PIXELS, MAX_FREQUENT_BACKGROUND_CANDIDATES, MAX_NORMAL_BACKGROUND_CANDIDATES } from './tables.js';


export function colorRefForProfile(profile: number, color: number) {
  if (!Number.isInteger(color)) throw new MCOImageV3InvalidInputError('Color must be an integer');
  if (!isDynamicProfile(profile)) {
    if (color < 0 || color >= paletteSize(profile)) {
      throw new MCOImageV3InvalidInputError(`Color ${color} is not available in ${PaletteProfileName[profile]}`);
    }
    return color;
  }
  const palette = DynamicGlobalIndices[profile];
  const ref = palette.indexOf(color);
  if (ref < 0) {
    throw new MCOImageV3InvalidInputError(`Color ${color} is not available in ${PaletteProfileName[profile]}`);
  }
  return ref;
}

export function isColorValid(profile: number, color: number) {
  try { colorRefForProfile(profile, color); return true; } catch (_) { return false; }
}

export function validateImageForEncode(imageLike: {
  width: unknown; height: unknown; paletteProfile: unknown; pixels?: ArrayLike<number> | null; transparentColor?: unknown;
} | null | undefined): V3Image {
  if (!imageLike || typeof imageLike !== 'object') throw new MCOImageV3InvalidInputError('image is required');
  const width = Number(imageLike.width);
  const height = Number(imageLike.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIZE || height < MIN_SIZE || width > MAX_SIZE || height > MAX_SIZE) {
    throw new MCOImageV3InvalidInputError('Image size must be 1..256 in both axes');
  }
  const profile = Number(imageLike.paletteProfile);
  if (!Number.isInteger(profile) || profile < 0 || profile >= PaletteProfileName.length) {
    throw new MCOImageV3InvalidInputError('Unknown MCOimg v3 palette profile');
  }
  const pixels: number[] = Array.from(imageLike.pixels || []);
  if (pixels.length !== width * height) throw new MCOImageV3InvalidInputError('Invalid pixel count');
  for (const pixel of pixels) colorRefForProfile(profile, pixel);
  const transparentColor = imageLike.transparentColor == null ? null : Number(imageLike.transparentColor);
  if (transparentColor != null) colorRefForProfile(profile, transparentColor);
  return { width, height, paletteProfile: profile, pixels, transparentColor };
}

export function writeColorRef(writer: BitWriter, profile: number, color: number) {
  return writer.writeBits(colorRefForProfile(profile, color), globalBits(profile));
}

export function isImplicitWhiteBackground(profile: number, color: number) {
  return color === whiteIndexFor(profile);
}

export function writeBackgroundRef(writer: BitWriter, profile: number, color: number, implicitWhiteBackground: boolean) {
  if (!implicitWhiteBackground) writeColorRef(writer, profile, color);
}

export function containerContextByte(container: number, context: number) {
  if (!Number.isInteger(container) || container < 0 || container >= 8) {
    throw new MCOImageV3InvalidInputError('MCOimg v3 container id does not fit');
  }
  if (!Number.isInteger(context) || context < 0 || context > CONTAINER_CONTEXT_MASK) {
    throw new MCOImageV3InvalidInputError('MCOimg v3 container context does not fit');
  }
  return (container << CONTAINER_CONTEXT_CONTAINER_SHIFT) | context;
}

export function writeDimensions(writer: BitWriter, width: number, height: number) {
  if (width === height && width <= 64) {
    writer.writeBits(DIMENSION_MODE_SQUARE64, 2).writeBits(width - 1, 6);
    return;
  }
  if (width <= 32 && height <= 32) {
    writer.writeBits(DIMENSION_MODE_SMALL32, 2).writeBits(width - 1, 5).writeBits(height - 1, 5);
    return;
  }
  if (width <= 64 && height <= 64) {
    writer.writeBits(DIMENSION_MODE_MEDIUM64, 2).writeBits(width - 1, 6).writeBits(height - 1, 6);
    return;
  }
  writer.writeBits(DIMENSION_MODE_EXTENDED, 2);
  if (width === height) writer.writeBits(0, 1).writeBits(width - 1, 8);
  else writer.writeBits(1, 1).writeBits(width - 1, 8).writeBits(height - 1, 8);
}

export function writeImagePreamble(writer: BitWriter, image: V3Image, scan: ScanModeId, implicitWhiteBackground: boolean, container: number, context: number) {
  const header = (image.transparentColor == null ? 0 : TRANSPARENT_FLAG) |
    (implicitWhiteBackground ? IMPLICIT_WHITE_BACKGROUND_FLAG : 0) |
    (scan << SCAN_SHIFT) |
    image.paletteProfile;
  writer.writeAlignedByte(header);
  writeDimensions(writer, image.width, image.height);
  writer.writeBits(containerContextByte(container, context), 8);
}

export function writeRegionGeometry(writer: BitWriter, bounds: Bounds, imageWidth: number, imageHeight: number, compactGeometry: boolean) {
  if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.x + bounds.width > imageWidth || bounds.y + bounds.height > imageHeight) {
    throw new MCOImageV3InvalidInputError('Invalid v3 region geometry');
  }
  const xBits = compactGeometry ? geometryBits(imageWidth) : 8;
  const yBits = compactGeometry ? geometryBits(imageHeight) : 8;
  writer.writeBits(bounds.x, xBits).writeBits(bounds.y, yBits);
  if (!compactGeometry) {
    writer.writeBits(bounds.width - 1, xBits).writeBits(bounds.height - 1, yBits);
  } else {
    writer.writeBits(bounds.width - 1, geometryBits(imageWidth - bounds.x));
    writer.writeBits(bounds.height - 1, geometryBits(imageHeight - bounds.y));
  }
}

export function writeSignedCompactInt(writer: BitWriter, value: number) {
  writer.writeCompactUint(value < 0 ? (-value * 2) - 1 : value * 2);
}

export function writeDeltaRegionGeometry(writer: BitWriter, bounds: Bounds, previous: Bounds) {
  writeSignedCompactInt(writer, bounds.x - previous.x);
  writeSignedCompactInt(writer, bounds.y - previous.y);
  writeSignedCompactInt(writer, bounds.width - previous.width);
  writeSignedCompactInt(writer, bounds.height - previous.height);
}

export function toScanOrder(pixels: number[], width: number, height: number, scan: ScanModeId) {
  if (scan === ScanMode.h) return Array.from(pixels);
  const result = [];
  if (scan === ScanMode.v) {
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) result.push(pixels[y * width + x]);
  } else if (scan === ScanMode.s) {
    for (let y = 0; y < height; y++) {
      if ((y & 1) === 0) for (let x = 0; x < width; x++) result.push(pixels[y * width + x]);
      else for (let x = width - 1; x >= 0; x--) result.push(pixels[y * width + x]);
    }
  } else if (scan === ScanMode.sv) {
    for (let x = 0; x < width; x++) {
      if ((x & 1) === 0) for (let y = 0; y < height; y++) result.push(pixels[y * width + x]);
      else for (let y = height - 1; y >= 0; y--) result.push(pixels[y * width + x]);
    }
  } else throw new MCOImageV3InvalidInputError('Unknown scan mode');
  return result;
}

export function extractBoundsPixels(image: V3Image, bounds: Bounds) {
  const result = [];
  for (let y = 0; y < bounds.height; y++) {
    const start = (bounds.y + y) * image.width + bounds.x;
    for (let x = 0; x < bounds.width; x++) result.push(image.pixels[start + x]);
  }
  return result;
}

export function boundsForBackground(image: V3Image, backgroundColor: number) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[y * image.width + x] === backgroundColor) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1,
    area: (maxX - minX + 1) * (maxY - minY + 1) };
}

export function localPalette(pixels: number[]) {
  const counts = new Map<number, number>();
  for (const pixel of pixels) counts.set(pixel, (counts.get(pixel) || 0) + 1);
  const colors = Array.from(counts.keys()).sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a - b));
  if (colors.length === 0) throw new MCOImageV3InvalidInputError('Empty local palette');
  return colors;
}


/** Per-encode memo tables (upstream module-level `active*Cache` variables). Reset by `runV3Encode`. */
export interface EncoderCaches {
  localIndexMap: Map<string, Map<number, number>> | null;
  localPixels: Map<string, number[]> | null;
  runs: Map<string, Array<{ color: number; length: number }>> | null;
  sparseAnalysis: Map<string, SparseAnalysis> | null;
  localPaletteVariant: Map<string, number[][]> | null;
  lzToken: Map<string, LzToken[]> | null;
  regionBody: Map<string, RegionBodyResult | null> | null;
  regionPlan: Map<string, RegionPlanCache> | null;
  regionLayoutCost: Map<string, number | null> | null;
}

export const caches: EncoderCaches = {
  localIndexMap: null,
  localPixels: null,
  runs: null,
  sparseAnalysis: null,
  localPaletteVariant: null,
  lzToken: null,
  regionBody: null,
  regionPlan: null,
  regionLayoutCost: null,
};

export function valueListCacheKey(values: number[]) {
  return values.join('.');
}

export function localIndexMap(palette: number[]) {
  const key = caches.localIndexMap == null ? null : valueListCacheKey(palette);
  if (key != null && caches.localIndexMap!.has(key)) return caches.localIndexMap!.get(key)!;
  const result = new Map<number, number>(palette.map((color, index): [number, number] => [color, index]));
  if (key != null) caches.localIndexMap!.set(key, result);
  return result;
}

export function mapPixelsToPalette(pixels: number[], palette: number[]) {
  const key = caches.localPixels == null ? null : `${valueListCacheKey(pixels)}|${valueListCacheKey(palette)}`;
  if (key != null && caches.localPixels!.has(key)) return caches.localPixels!.get(key)!;
  const map = localIndexMap(palette);
  const result = pixels.map((color) => {
    const index = map.get(color);
    if (index == null) throw new MCOImageV3InvalidInputError('Local palette is missing a color');
    return index;
  });
  if (key != null) caches.localPixels!.set(key, result);
  return result;
}

export function buildRuns(pixels: number[]) {
  const key = caches.runs == null ? null : valueListCacheKey(pixels);
  if (key != null && caches.runs!.has(key)) return caches.runs!.get(key)!;
  if (pixels.length === 0) return [];
  const runs: Array<{ color: number; length: number }> = [];
  let color = pixels[0], length = 1;
  for (let i = 1; i < pixels.length; i++) {
    if (pixels[i] === color) length++;
    else { runs.push({ color, length }); color = pixels[i]; length = 1; }
  }
  runs.push({ color, length });
  if (key != null) caches.runs!.set(key, runs);
  return runs;
}

export function buildSparseSegments(pixels: number[], backgroundColor: number) {
  const segments: SparseSegment[] = [];
  let index = 0;
  while (index < pixels.length) {
    if (pixels[index] === backgroundColor) { index++; continue; }
    const start = index;
    const color = pixels[index++];
    while (index < pixels.length && pixels[index] === color) index++;
    segments.push({ start, color, length: index - start });
  }
  return segments;
}

export function sparseAnalysis(pixels: number[], backgroundColor: number) {
  const key = caches.sparseAnalysis == null ? null : `${backgroundColor}|${valueListCacheKey(pixels)}`;
  if (key != null && caches.sparseAnalysis!.has(key)) return caches.sparseAnalysis!.get(key)!;
  const foregroundColors = Array.from(new Set(pixels.filter((color) => color !== backgroundColor))).sort((a, b) => a - b);
  const result: SparseAnalysis = { segments: buildSparseSegments(pixels, backgroundColor), foregroundColors };
  if (key != null) caches.sparseAnalysis!.set(key, result);
  return result;
}

export function imageModeForAlgorithm(algorithm: McoImageV3BlockAlgorithmId) {
  switch (algorithm) {
    case MCOImageV3BlockAlgorithm.rawGlobal: return ImageMode.rawGlobal;
    case MCOImageV3BlockAlgorithm.rawLocal: return ImageMode.rawLocal;
    case MCOImageV3BlockAlgorithm.compactRle:
    case MCOImageV3BlockAlgorithm.varUintRle: return ImageMode.rleLocal;
    case MCOImageV3BlockAlgorithm.compactSparse:
    case MCOImageV3BlockAlgorithm.varUintSparse: return ImageMode.sparseBg;
    case MCOImageV3BlockAlgorithm.biColorMask: return ImageMode.biColorMask;
    case MCOImageV3BlockAlgorithm.rowRepeat: return ImageMode.rowRepeat;
    case MCOImageV3BlockAlgorithm.rowDelta: return ImageMode.rowDelta;
    default: return ImageMode.extended;
  }
}

export function modeTieRank(mode: number) {
  switch (mode) {
    case ImageMode.biColorMask: return 0;
    case ImageMode.sparseBg: return 1;
    case ImageMode.rowRepeat: return 2;
    case ImageMode.rleLocal: return 3;
    case ImageMode.rawLocal: return 4;
    case ImageMode.rawGlobal: return 5;
    case ImageMode.extended: return 6;
    case ImageMode.rowDelta: return 7;
    case ImageMode.regionsBg: return 8;
    default: return 99;
  }
}

export function makeCandidate(payload: Uint8Array, options: EncodeOptions = {}): Candidate {
  return Object.freeze({
    payload,
    body: payload,
    text: '',
    mode: options.mode ?? ImageMode.extended,
    modeName: ImageModeName[options.mode ?? ImageMode.extended],
    scan: options.scan ?? ScanMode.h,
    scanName: ScanModeName[options.scan ?? ScanMode.h],
    byteLength: payload.length,
    charLength: 0,
    boundsPresent: options.boundsPresent === true,
    boundsX: options.boundsX ?? null,
    boundsY: options.boundsY ?? null,
    boundsWidth: options.boundsWidth ?? null,
    boundsHeight: options.boundsHeight ?? null,
    backgroundColor: options.backgroundColor ?? null,
    transparentColor: options.transparentColor ?? null,
    regionCount: options.regionCount ?? 0,
    backgroundRank: options.backgroundRank ?? 0,
    codecVersion: 3,
    localPaletteSize: options.localPaletteSize ?? null,
    bitsPerLocalPixel: options.bitsPerLocalPixel ?? null,
    requestedEncodingVersion: 3,
    actualEncodingVersion: 3,
    paletteKind: options.paletteKind ?? 'fixed',
    container: options.container ?? 'block',
    algorithm: options.algorithm ?? null,
  });
}

export function withPacketNonce(candidate: Candidate, nonce: number) {
  const payload = new Uint8Array(candidate.payload.length + 1);
  payload[0] = nonce;
  payload.set(candidate.payload, 1);
  return makeCandidate(payload, candidate);
}

export function localPaletteSizeFor(linear: number[], algorithm: McoImageV3BlockAlgorithmId, backgroundColor: number) {
  switch (algorithm) {
    case MCOImageV3BlockAlgorithm.rawLocal:
    case MCOImageV3BlockAlgorithm.compactRle:
    case MCOImageV3BlockAlgorithm.varUintRle:
    case MCOImageV3BlockAlgorithm.lzPixels:
    case MCOImageV3BlockAlgorithm.quadtree:
    case MCOImageV3BlockAlgorithm.bitplanes:
    case MCOImageV3BlockAlgorithm.adaptiveBitplanes:
    case MCOImageV3BlockAlgorithm.compactRowDelta:
    case MCOImageV3BlockAlgorithm.rowDelta:
    case MCOImageV3BlockAlgorithm.rowRepeat:
      return new Set(linear).size;
    case MCOImageV3BlockAlgorithm.compactSparse:
    case MCOImageV3BlockAlgorithm.varUintSparse:
      return new Set(linear.filter((color) => color !== backgroundColor)).size;
    case MCOImageV3BlockAlgorithm.biColorMask: return 2;
    default: return null;
  }
}

export function bitsPerLocalPixelFor(linear: number[], algorithm: McoImageV3BlockAlgorithmId, backgroundColor: number) {
  const size = localPaletteSizeFor(linear, algorithm, backgroundColor);
  return size == null || size <= 0 ? null : localBits(size);
}

export function normalBackgroundCandidates(image: V3Image, preferredBackground: number) {
  const result: BackgroundCandidate[] = [], seen = new Set<number>();
  const add = (color: number, rank: number) => {
    if (result.length >= MAX_NORMAL_BACKGROUND_CANDIDATES || !isColorValid(image.paletteProfile, color) || seen.has(color)) return;
    seen.add(color); result.push({ color, rank });
  };
  add(preferredBackground, 0);
  const counts = new Map<number, number>();
  for (const pixel of image.pixels) counts.set(pixel, (counts.get(pixel) || 0) + 1);
  const colors = Array.from(counts.keys()).sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a - b));
  for (let i = 0; i < colors.length && result.length < MAX_NORMAL_BACKGROUND_CANDIDATES; i++) add(colors[i], 1 + i);
  return result;
}

export function fullBackgroundCandidates(image: V3Image, explicitBackground: number, exhaustiveSmallImage: boolean) {
  const result: BackgroundCandidate[] = [], seen = new Set<number>();
  const add = (color: number, rank: number) => {
    if (!isColorValid(image.paletteProfile, color) || seen.has(color)) return;
    seen.add(color); result.push({ color, rank });
  };
  if (explicitBackground != null) add(explicitBackground, 0);
  add(whiteIndexFor(image.paletteProfile), 1);
  const counts = new Map<number, number>();
  for (const pixel of image.pixels) counts.set(pixel, (counts.get(pixel) || 0) + 1);
  const colors = Array.from(counts.keys()).sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a - b));
  for (let i = 0; i < Math.min(MAX_FREQUENT_BACKGROUND_CANDIDATES, colors.length); i++) add(colors[i], 2 + i);
  if (exhaustiveSmallImage && image.pixels.length <= MAX_EXHAUSTIVE_BACKGROUND_PIXELS && colors.length <= MAX_EXHAUSTIVE_BACKGROUND_COLORS) {
    for (let i = 0; i < colors.length; i++) add(colors[i], 2 + i);
  }
  return result;
}


