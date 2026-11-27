/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 3707-4019
 *          (quadtree, row repeat, block body writer, top-level, bounds, solid and solid-rects candidates)
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
import type { Bounds, V3Image, EncodeOptions, Candidate } from './types.js';
import type { LocalBodyWriter } from './localPaletteWriter.js';
import type { McoImageV3BlockAlgorithmId, ScanModeId } from '../constants.js';
import { McoImageV3Container as MCOImageV3Container } from '../constants.js';
import { McoImageV3ContainerName as MCOImageV3ContainerName } from '../constants.js';
import { isGrayscaleProfile } from '../palettes.js';
import { blockAlgorithmUsesBackgroundRef } from '../validate.js';
import { localBits, canUseCompactBlockHeader } from '../validate.js';
import { isDynamicProfile, globalBits } from '../palettes.js';
import { rowLengthForScan } from '../blockBodies.js';
import {
  CONTAINER_CONTEXT_MASK,
  ScanMode,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError, McoImageV3CodecError as MCOImageV3CodecError } from '../errors.js';
import { McoImageV3BlockAlgorithm as MCOImageV3BlockAlgorithm } from '../constants.js';
import { BitWriter } from './bitWriter.js';
import { writeAdaptiveBitplanesBody, writeLegacyBitplanesBody } from './bitplanes.js';
import { bitsPerLocalPixelFor, buildRuns, colorRefForProfile, imageModeForAlgorithm, isImplicitWhiteBackground, localIndexMap, localPalette, localPaletteSizeFor, makeCandidate, sparseAnalysis, writeBackgroundRef, writeColorRef, writeImagePreamble, writeRegionGeometry } from './common.js';
import { writeBestLocalPaletteBlock, writeLocalPalette } from './localPaletteWriter.js';
import { buildGreedyLzTokens, buildOptimalLzTokens, lzTokensBitCost, writeLzTokens } from './lz.js';
import { writeCompactRowDeltaBodyEncoder, writeRowDeltaBodyEncoder } from './rowDelta.js';
import { ImageMode } from './tables.js';

export function writeQuadtreeNodeEncoder(writer: BitWriter, pixels: number[], stride: number, x: number, y: number, width: number, height: number, bits: number) {
  const first = pixels[y * stride + x];
  let solid = true;
  for (let dy = 0; dy < height && solid; dy++) for (let dx = 0; dx < width; dx++) {
    if (pixels[(y + dy) * stride + x + dx] !== first) { solid = false; break; }
  }
  if (solid) { writer.writeBits(1, 1); writer.writeBits(first, bits); return; }
  writer.writeBits(0, 1);
  if (width === 1) {
    const top = Math.floor(height / 2);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x, y, width, top, bits);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x, y + top, width, height - top, bits);
  } else if (height === 1) {
    const left = Math.floor(width / 2);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x, y, left, height, bits);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x + left, y, width - left, height, bits);
  } else {
    const left = Math.floor(width / 2), top = Math.floor(height / 2);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x, y, left, top, bits);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x + left, y, width - left, top, bits);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x, y + top, left, height - top, bits);
    writeQuadtreeNodeEncoder(writer, pixels, stride, x + left, y + top, width - left, height - top, bits);
  }
}

export function writeRowRepeatEncoder(writer: BitWriter, pixels: number[], rowLength: number, bits: number) {
  if (rowLength <= 0 || pixels.length % rowLength !== 0) throw new MCOImageV3InvalidInputError('Invalid row-repeat geometry');
  for (let x = 0; x < rowLength; x++) writer.writeBits(pixels[x], bits);
  const rows = pixels.length / rowLength;
  for (let row = 1; row < rows; row++) {
    const start = row * rowLength, previous = start - rowLength;
    let same = true;
    for (let x = 0; x < rowLength; x++) if (pixels[start + x] !== pixels[previous + x]) { same = false; break; }
    writer.writeBits(same ? 1 : 0, 1);
    if (!same) for (let x = 0; x < rowLength; x++) writer.writeBits(pixels[start + x], bits);
  }
}

export function biColorForeground(linear: number[], backgroundColor: number) {
  let foreground: number | null = null;
  for (const pixel of linear) {
    if (pixel === backgroundColor) continue;
    if (foreground == null) foreground = pixel;
    else if (pixel !== foreground) return null;
  }
  return foreground;
}

interface LocalBlockConfig {
  indexOrderSensitive?: boolean;
  includeBitplaneOptimizedOrder?: boolean;
  includeRgbOrder?: boolean;
  preferredFirstColor?: number | null;
}

export function writeBlockBodyEncoder(writer: BitWriter, linear: number[], profile: number, algorithm: McoImageV3BlockAlgorithmId, options: EncodeOptions) {
  const backgroundColor = options.backgroundColor as number;
  const rowLength = options.rowLength as number;
  const backgroundInherited = !!options.backgroundInherited;
  const high = !!options.useHighCompressionExtras;
  const optimizePaletteOrder = high;
  const localBlock = (config: LocalBlockConfig, bodyWriter: LocalBodyWriter) => writeBestLocalPaletteBlock(writer, linear, profile, {
    indexOrderSensitive: !!config.indexOrderSensitive,
    includeTransitionOrder: optimizePaletteOrder,
    includeBitplaneOptimizedOrder: optimizePaletteOrder && !!config.includeBitplaneOptimizedOrder,
    includeRgbOrder: optimizePaletteOrder && !!config.includeRgbOrder,
    preferredFirstColor: config.preferredFirstColor,
  }, bodyWriter);
  switch (algorithm) {
    case MCOImageV3BlockAlgorithm.rawGlobal:
      for (const color of linear) writeColorRef(writer, profile, color);
      return;
    case MCOImageV3BlockAlgorithm.rawLocal:
      localBlock({}, (w, pixels, bits) => { for (const p of pixels) w.writeBits(p, bits); }); return;
    case MCOImageV3BlockAlgorithm.compactRle:
      localBlock({}, (w, pixels, bits) => { let consumed = 0; for (const run of buildRuns(pixels)) {
        w.writeBits(run.color, bits); w.writeBoundedCompactUint(run.length - 1, pixels.length - consumed - 1); consumed += run.length;
      }}); return;
    case MCOImageV3BlockAlgorithm.varUintRle:
      localBlock({}, (w, pixels, bits) => { for (const run of buildRuns(pixels)) { w.writeBits(run.color, bits); w.writeBitVarUint(run.length); } }); return;
    case MCOImageV3BlockAlgorithm.lzPixels:
      localBlock({}, (w, pixels, bits) => {
        const greedy = buildGreedyLzTokens(pixels, bits);
        let tokens = greedy;
        if (!options.greedyLzOnly && pixels.length <= 1024) {
          const optimal = buildOptimalLzTokens(pixels, bits);
          if (optimal && lzTokensBitCost(optimal, bits, pixels.length) < lzTokensBitCost(greedy, bits, pixels.length)) tokens = optimal;
        }
        writeLzTokens(w, tokens, bits, pixels.length);
      }); return;
    case MCOImageV3BlockAlgorithm.quadtree:
      if (rowLength <= 0 || linear.length % rowLength !== 0) throw new MCOImageV3InvalidInputError('Invalid quadtree geometry');
      localBlock({}, (w, pixels, bits) => writeQuadtreeNodeEncoder(w, pixels, rowLength, 0, 0, rowLength, linear.length / rowLength, bits)); return;
    case MCOImageV3BlockAlgorithm.bitplanes:
      localBlock({ indexOrderSensitive: true, preferredFirstColor: backgroundColor }, (w, pixels, bits) => writeLegacyBitplanesBody(w, pixels, bits)); return;
    case MCOImageV3BlockAlgorithm.adaptiveBitplanes:
      localBlock({ indexOrderSensitive: true, includeBitplaneOptimizedOrder: true, includeRgbOrder: true, preferredFirstColor: backgroundColor },
        (w, pixels, bits) => writeAdaptiveBitplanesBody(w, pixels, bits)); return;
    case MCOImageV3BlockAlgorithm.directBitplanes:
      if (isGrayscaleProfile(profile)) writeAdaptiveBitplanesBody(writer, linear, globalBits(profile));
      else if (isDynamicProfile(profile)) writeAdaptiveBitplanesBody(writer, linear.map(c => colorRefForProfile(profile, c)), globalBits(profile));
      else throw new MCOImageV3InvalidInputError('Direct bitplanes require grayscale or dynamic profile');
      return;
    case MCOImageV3BlockAlgorithm.rowDelta:
      localBlock({ indexOrderSensitive: true, preferredFirstColor: backgroundColor }, (w, pixels, bits) => writeRowDeltaBodyEncoder(w, pixels, rowLength, bits)); return;
    case MCOImageV3BlockAlgorithm.compactRowDelta:
      localBlock({ indexOrderSensitive: true, preferredFirstColor: backgroundColor }, (w, pixels, bits) => writeCompactRowDeltaBodyEncoder(w, pixels, rowLength, bits, false)); return;
    case MCOImageV3BlockAlgorithm.directRowDelta:
      if (isGrayscaleProfile(profile)) writeCompactRowDeltaBodyEncoder(writer, linear, rowLength, globalBits(profile), true);
      else if (isDynamicProfile(profile)) writeCompactRowDeltaBodyEncoder(writer, linear.map(c => colorRefForProfile(profile, c)), rowLength, globalBits(profile), false);
      else throw new MCOImageV3InvalidInputError('Direct row-delta requires grayscale or dynamic profile');
      return;
    case MCOImageV3BlockAlgorithm.varUintSparse:
    case MCOImageV3BlockAlgorithm.compactSparse: {
      if (!backgroundInherited) writeBackgroundRef(writer, profile, backgroundColor, isImplicitWhiteBackground(profile, backgroundColor));
      const analysis = sparseAnalysis(linear, backgroundColor);
      if (!analysis.segments.length || !analysis.foregroundColors.length) throw new MCOImageV3InvalidInputError('Empty sparse body');
      writeLocalPalette(writer, profile, analysis.foregroundColors);
      const map = localIndexMap(analysis.foregroundColors), bits = localBits(analysis.foregroundColors.length);
      if (algorithm === MCOImageV3BlockAlgorithm.varUintSparse) writer.writeBitVarUint(analysis.segments.length);
      else writer.writeBoundedCompactUint(analysis.segments.length - 1, linear.length - 1);
      let pos = 0;
      for (const segment of analysis.segments) {
        if (algorithm === MCOImageV3BlockAlgorithm.varUintSparse) {
          writer.writeBitVarUint(segment.start - pos); writer.writeBits(map.get(segment.color)!, bits); writer.writeBitVarUint(segment.length);
        } else {
          writer.writeBoundedCompactUint(segment.start - pos, linear.length - pos - 1);
          writer.writeBits(map.get(segment.color)!, bits);
          writer.writeBoundedCompactUint(segment.length - 1, linear.length - segment.start - 1);
        }
        pos = segment.start + segment.length;
      }
      return;
    }
    case MCOImageV3BlockAlgorithm.biColorMask: {
      const foreground = biColorForeground(linear, backgroundColor);
      if (foreground == null) throw new MCOImageV3InvalidInputError('Not a bi-color image');
      if (!backgroundInherited) writeBackgroundRef(writer, profile, backgroundColor, isImplicitWhiteBackground(profile, backgroundColor));
      writeColorRef(writer, profile, foreground);
      for (const color of linear) writer.writeBits(color === foreground ? 1 : 0, 1);
      return;
    }
    case MCOImageV3BlockAlgorithm.rowRepeat:
      localBlock({}, (w, pixels, bits) => writeRowRepeatEncoder(w, pixels, rowLength, bits)); return;
    default: throw new MCOImageV3InvalidInputError('Unknown block algorithm');
  }
}

export interface BlockBody {
  bytes: Uint8Array;
  bitLength: number;
}

export function tryBuildBlockBodyEncoding(image: V3Image, linear: number[], algorithm: McoImageV3BlockAlgorithmId, options: EncodeOptions) {
  const writer = new BitWriter();
  try {
    writeBlockBodyEncoder(writer, linear, image.paletteProfile, algorithm, options);
  } catch (error) {
    if (error instanceof MCOImageV3CodecError) return null;
    throw error;
  }
  const bitLengthValue = writer.bitLength;
  if (bitLengthValue === 0) return null;
  return { bytes: writer.toBytes(), bitLength: bitLengthValue };
}

export function tryBuildTopLevelCandidate(image: V3Image, linear: number[], algorithm: McoImageV3BlockAlgorithmId, scan: ScanModeId, options: EncodeOptions) {
  const backgroundColor = options.backgroundColor as number;
  if (options.compactHeader && (scan !== ScanMode.h || !canUseCompactBlockHeader(algorithm))) return null;
  if (algorithm === MCOImageV3BlockAlgorithm.quadtree && scan !== ScanMode.h) return null;
  const implicit = blockAlgorithmUsesBackgroundRef(algorithm) && isImplicitWhiteBackground(image.paletteProfile, backgroundColor);
  const writer = new BitWriter();
  const container = options.compactHeader ? MCOImageV3Container.compactBlock : MCOImageV3Container.block;
  writeImagePreamble(writer, image, scan, implicit, container, algorithm);
  if (image.transparentColor != null) writeColorRef(writer, image.paletteProfile, image.transparentColor);
  const before = writer.bitLength;
  try {
    writeBlockBodyEncoder(writer, linear, image.paletteProfile, algorithm, {
      backgroundColor: backgroundColor,
      rowLength: rowLengthForScan(scan, image.width, image.height),
      backgroundInherited: false,
      greedyLzOnly: options.greedyLzOnly,
      useHighCompressionExtras: options.useHighCompressionExtras,
    });
  } catch (error) {
    if (error instanceof MCOImageV3CodecError) return null;
    throw error;
  }
  if (writer.bitLength === before) return null;
  const payload = writer.toBytes();
  return makeCandidate(payload, {
    mode: imageModeForAlgorithm(algorithm), scan,
    backgroundColor: backgroundColor, transparentColor: image.transparentColor,
    localPaletteSize: localPaletteSizeFor(linear, algorithm, backgroundColor),
    bitsPerLocalPixel: bitsPerLocalPixelFor(linear, algorithm, backgroundColor),
    paletteKind: isDynamicProfile(image.paletteProfile) ? 'dynamic' : 'fixed',
    container: MCOImageV3ContainerName[container], algorithm,
  });
}

export function tryWrapBoundsCandidate(image: V3Image, bounds: Bounds, linear: number[], body: BlockBody, algorithm: McoImageV3BlockAlgorithmId, scan: ScanModeId, options: EncodeOptions) {
  const backgroundColor = options.backgroundColor as number;
  if (options.compactGeometry && canUseCompactBlockHeader(algorithm) && scan !== ScanMode.h) return null;
  if (algorithm === MCOImageV3BlockAlgorithm.quadtree && scan !== ScanMode.h) return null;
  const implicit = isImplicitWhiteBackground(image.paletteProfile, backgroundColor);
  const container = options.compactGeometry ? MCOImageV3Container.compactBoundsBlock : MCOImageV3Container.boundsBlock;
  const writer = new BitWriter();
  writeImagePreamble(writer, image, scan, implicit, container, algorithm);
  if (image.transparentColor != null) writeColorRef(writer, image.paletteProfile, image.transparentColor);
  writeBackgroundRef(writer, image.paletteProfile, backgroundColor, implicit);
  writeRegionGeometry(writer, bounds, image.width, image.height, options.compactGeometry as boolean);
  writer.writeBitStream(body.bytes, body.bitLength);
  const payload = writer.toBytes();
  return makeCandidate(payload, {
    mode: imageModeForAlgorithm(algorithm), scan,
    backgroundColor: backgroundColor, transparentColor: image.transparentColor,
    boundsPresent: true, boundsX: bounds.x, boundsY: bounds.y,
    boundsWidth: bounds.width, boundsHeight: bounds.height,
    localPaletteSize: localPaletteSizeFor(linear, algorithm, backgroundColor),
    bitsPerLocalPixel: bitsPerLocalPixelFor(linear, algorithm, backgroundColor),
    paletteKind: isDynamicProfile(image.paletteProfile) ? 'dynamic' : 'fixed',
    container: MCOImageV3ContainerName[container], algorithm,
  });
}

export function tryBuildSolidBackgroundCandidate(image: V3Image) {
  if (!image.pixels.length) return null;
  const color = image.pixels[0];
  for (const pixel of image.pixels) if (pixel !== color) return null;
  const implicit = isImplicitWhiteBackground(image.paletteProfile, color);
  const ref = implicit ? 0 : colorRefForProfile(image.paletteProfile, color);
  const writer = new BitWriter();
  writeImagePreamble(writer, image, ScanMode.h, implicit, MCOImageV3Container.solidBackground, ref & CONTAINER_CONTEXT_MASK);
  if (image.transparentColor != null) writeColorRef(writer, image.paletteProfile, image.transparentColor);
  if (!implicit) {
    const tail = ref >> 5;
    if (tail > 0) writer.writeBits(tail, Math.max(0, globalBits(image.paletteProfile) - 5));
  }
  return makeCandidate(writer.toBytes(), {
    mode: ImageMode.rawGlobal, scan: ScanMode.h, backgroundColor: color,
    transparentColor: image.transparentColor, localPaletteSize: 1, bitsPerLocalPixel: 0,
    paletteKind: isDynamicProfile(image.paletteProfile) ? 'dynamic' : 'fixed',
    container: MCOImageV3ContainerName[MCOImageV3Container.solidBackground],
  });
}

export interface SolidRect {
  bounds: Bounds;
  color: number;
}

export function solidRectVariantsEncoder(pixels: number[], width: number, height: number, background: number, maxRects = 64) {
  const horizontal: SolidRect[] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const color = pixels[y * width + x];
      if (color === background) { x++; continue; }
      const start = x;
      while (x < width && pixels[y * width + x] === color) x++;
      horizontal.push({ bounds: { x: start, y, width: x - start, height: 1 }, color });
    }
  }
  const vertical: SolidRect[] = [];
  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      const color = pixels[y * width + x];
      if (color === background) { y++; continue; }
      const start = y;
      while (y < height && pixels[y * width + x] === color) y++;
      vertical.push({ bounds: { x, y: start, width: 1, height: y - start }, color });
    }
  }
  const merge = (runs: SolidRect[], verticalMode: boolean) => {
    const merged: SolidRect[] = [], latest = new Map<string, number>();
    for (const run of runs) {
      const b = run.bounds;
      const key = verticalMode ? `${b.y}:${b.height}:${run.color}` : `${b.x}:${b.width}:${run.color}`;
      const index = latest.get(key);
      if (index != null) {
        const previous = merged[index];
        const touches = verticalMode
          ? previous.bounds.x + previous.bounds.width === b.x
          : previous.bounds.y + previous.bounds.height === b.y;
        if (touches) {
          previous.bounds = {
            x: previous.bounds.x, y: previous.bounds.y,
            width: verticalMode ? previous.bounds.width + b.width : previous.bounds.width,
            height: verticalMode ? previous.bounds.height : previous.bounds.height + b.height,
          };
          continue;
        }
      }
      latest.set(key, merged.length);
      merged.push({ bounds: { ...b }, color: run.color });
    }
    return merged;
  };
  const result = [merge(horizontal, false), merge(vertical, true)];
  return result.filter(rects => rects.length > 0 && rects.length <= maxRects);
}

export function tryBuildSolidRectsCandidate(image: V3Image, backgroundColor: number, backgroundRank: number) {
  let best: Candidate | null = null;
  for (const rects of solidRectVariantsEncoder(image.pixels, image.width, image.height, backgroundColor)) {
    const implicit = isImplicitWhiteBackground(image.paletteProfile, backgroundColor);
    const writer = new BitWriter();
    const code = rects.length - 1;
    writeImagePreamble(writer, image, ScanMode.h, implicit, MCOImageV3Container.solidRects, code & CONTAINER_CONTEXT_MASK);
    if (image.transparentColor != null) writeColorRef(writer, image.paletteProfile, image.transparentColor);
    writeBackgroundRef(writer, image.paletteProfile, backgroundColor, implicit);
    const palette = localPalette(rects.map(r => r.color));
    writeLocalPalette(writer, image.paletteProfile, palette);
    const map = localIndexMap(palette), bits = localBits(palette.length);
    writer.writeBits(code >> 5, 1);
    for (const rect of rects) {
      writeRegionGeometry(writer, rect.bounds, image.width, image.height, true);
      writer.writeBits(map.get(rect.color)!, bits);
    }
    const candidate = makeCandidate(writer.toBytes(), {
      mode: ImageMode.extended, scan: ScanMode.h, backgroundColor, backgroundRank,
      transparentColor: image.transparentColor, regionCount: rects.length,
      localPaletteSize: palette.length, bitsPerLocalPixel: bits,
      paletteKind: isDynamicProfile(image.paletteProfile) ? 'dynamic' : 'fixed',
      container: MCOImageV3ContainerName[MCOImageV3Container.solidRects],
    });
    if (!best || candidate.byteLength < best.byteLength) best = candidate;
  }
  return best;
}
