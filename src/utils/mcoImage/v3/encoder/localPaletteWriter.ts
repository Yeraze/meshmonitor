/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 2553-2823, 2829-2920
 *          (local palette descriptors and variants; PALETTE_RGB (2541-2552) and paletteRgb (2824-2828) reuse ../palettes.ts)
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
import type { EncodeOptions } from './types.js';
import { bitLength, bitCount } from '../bitReader.js';
import { localBits } from '../validate.js';
import { paletteSize, globalBits, paletteRgb } from '../palettes.js';
import {
  LOCAL_PALETTE_BANK_DESCRIPTOR_BITMAPS,
  LOCAL_PALETTE_BANK_DESCRIPTOR_ORDERED_8X64,
  LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS,
  LOCAL_PALETTE_DESCRIPTOR_BITMAP,
  LOCAL_PALETTE_DESCRIPTOR_BITS,
  LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS,
  LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA,
  LOCAL_PALETTE_LARGE_LENGTH_LIMIT,
  LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT,
  LOCAL_PALETTE_SMALL_LENGTH_LIMIT,
  PaletteProfile,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError, McoImageV3CodecError as MCOImageV3CodecError } from '../errors.js';
import { BitWriter } from './bitWriter.js';
import { bitplaneOptimizedLocalPalettes } from './bitplanes.js';
import { colorRefForProfile, localPalette, mapPixelsToPalette, valueListCacheKey, writeColorRef } from './common.js';
import { caches } from './common.js';

export function compactUintBitLength(value: number) {
  if (value <= 3) return 3;
  if (value <= 19) return 6;
  if (value <= 275) return 11;
  let bytes = 1, current = value;
  while (current >= 128) { current = Math.floor(current / 128); bytes++; }
  return 3 + bytes * 8;
}

export function rangeCompactUintBitLength(value: number, maxValue: number) {
  return maxValue <= 7 ? bitLength(maxValue) : compactUintBitLength(value);
}

export function localPaletteFlatPrefixBitLength(profile: number, length: number) {
  const size = paletteSize(profile);
  if (length <= 0 || length > size) throw new MCOImageV3InvalidInputError('Invalid local palette size');
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) return 1 + globalBits(profile);
  if (length <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) return 7;
  if (length <= LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT) return 8;
  return 11;
}

export function localPaletteDescriptorPrefixBitLength(profile: number) {
  return paletteSize(profile) <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT
    ? 1 + LOCAL_PALETTE_DESCRIPTOR_BITS
    : 4 + LOCAL_PALETTE_DESCRIPTOR_BITS;
}

export function localPaletteLengthBitLength(profile: number, length: number) {
  const size = paletteSize(profile);
  if (length <= 0 || length > size) throw new MCOImageV3InvalidInputError('Invalid local palette size');
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) return globalBits(profile);
  if (length <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) return 7;
  if (length <= LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT) return 8;
  return 2 + bitLength(size - 129);
}

export function localPaletteRefRanges(profile: number, colors: number[]) {
  const refs = colors.map((color) => colorRefForProfile(profile, color));
  const ranges = [];
  let start = refs[0], previous = start;
  for (let i = 1; i < refs.length; i++) {
    const ref = refs[i];
    if (ref === previous + 1) previous = ref;
    else { ranges.push({ start, end: previous, length: previous - start + 1 }); start = previous = ref; }
  }
  ranges.push({ start, end: previous, length: previous - start + 1 });
  return ranges;
}

export function isProfileSortedLocalPalette(profile: number, colors: number[]) {
  let previous = -1;
  const seen = new Set();
  for (const color of colors) {
    const ref = colorRefForProfile(profile, color);
    if (seen.has(color)) throw new MCOImageV3InvalidInputError('Duplicate local color');
    seen.add(color);
    if (ref <= previous) return false;
    previous = ref;
  }
  return true;
}

export function localPaletteSortedDeltaBitCost(profile: number, colors: number[]) {
  let cost = localPaletteDescriptorPrefixBitLength(profile) +
    localPaletteLengthBitLength(profile, colors.length) + globalBits(profile);
  let previous = colorRefForProfile(profile, colors[0]);
  for (let i = 1; i < colors.length; i++) {
    const ref = colorRefForProfile(profile, colors[i]);
    cost += compactUintBitLength(ref - previous - 1);
    previous = ref;
  }
  return cost;
}

export function localPaletteRangeRunsBitCost(profile: number, colors: number[]) {
  const runs = localPaletteRefRanges(profile, colors);
  let cost = localPaletteDescriptorPrefixBitLength(profile) +
    rangeCompactUintBitLength(runs.length - 1, paletteSize(profile) - 1);
  for (const run of runs) cost += globalBits(profile) + compactUintBitLength(run.length - 1);
  return cost;
}

export function localPaletteBankBitmapsBitCost(colors: number[]) {
  let bankMask = 0;
  for (const color of colors) bankMask |= 1 << (colorRefForProfile(PaletteProfile.dynamicGlobal512, color) >> 6);
  return localPaletteDescriptorPrefixBitLength(PaletteProfile.dynamicGlobal512) + 1 + 8 + bitCount(bankMask) * 64;
}

export function localPaletteOrderedBanked8x64BitCost(colors: number[]) {
  const refs = colors.map((color) => colorRefForProfile(PaletteProfile.dynamicGlobal512, color));
  let bankMask = 0;
  for (const ref of refs) bankMask |= 1 << (ref >> 6);
  const bankCount = bitCount(bankMask);
  const bankChoiceBits = bankCount <= 1 ? 0 : bitLength(bankCount - 1);
  return localPaletteDescriptorPrefixBitLength(PaletteProfile.dynamicGlobal512) + 1 +
    localPaletteLengthBitLength(PaletteProfile.dynamicGlobal512, colors.length) + 1 +
    (bankCount === 1 ? 3 : 8) + colors.length * (6 + bankChoiceBits);
}

export function bestLocalPaletteDescriptor(profile: number, colors: number[]) {
  const flatBits = localPaletteFlatPrefixBitLength(profile, colors.length) + colors.length * globalBits(profile);
  const prefixBits = localPaletteDescriptorPrefixBitLength(profile);
  const candidates = [];
  const sorted = isProfileSortedLocalPalette(profile, colors);
  if (sorted) {
    candidates.push({ descriptor: LOCAL_PALETTE_DESCRIPTOR_BITMAP, bitCost: prefixBits + paletteSize(profile) });
    candidates.push({ descriptor: LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA, bitCost: localPaletteSortedDeltaBitCost(profile, colors) });
    candidates.push({ descriptor: LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS, bitCost: localPaletteRangeRunsBitCost(profile, colors) });
  }
  if (profile === PaletteProfile.dynamicGlobal512) {
    if (sorted) candidates.push({ descriptor: LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS, bitCost: localPaletteBankBitmapsBitCost(colors) });
    candidates.push({ descriptor: 4, bitCost: localPaletteOrderedBanked8x64BitCost(colors) });
  }
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) if (candidates[i].bitCost < best.bitCost) best = candidates[i];
  return best.bitCost < flatBits ? best.descriptor : null;
}

export function writeLocalPaletteFlatPrefix(writer: BitWriter, profile: number, length: number) {
  const size = paletteSize(profile);
  if (length <= 0 || length > size) throw new MCOImageV3InvalidInputError('Invalid local palette size');
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) {
    writer.writeBits(0, 1).writeBits(length - 1, globalBits(profile));
  } else if (length <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) {
    writer.writeBits(0, 1).writeBits(length - 1, 6);
  } else if (length <= LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT) {
    writer.writeBits(1, 1).writeBits(0, 1).writeBits(length - 65, 6);
  } else if (length <= LOCAL_PALETTE_LARGE_LENGTH_LIMIT) {
    writer.writeBits(1, 1).writeBits(1, 1).writeBits(0, 1).writeBits(length - 129, 8);
  } else {
    writer.writeBits(1, 1).writeBits(1, 1).writeBits(1, 1).writeBits(0, 1).writeBits(length - 385, 7);
  }
}

export function writeLocalPaletteDescriptorPrefix(writer: BitWriter, profile: number, descriptor: number) {
  if (descriptor < 0 || descriptor >= 4) throw new MCOImageV3InvalidInputError('Invalid local palette descriptor');
  if (paletteSize(profile) <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) writer.writeBits(1, 1);
  else writer.writeBits(1, 1).writeBits(1, 1).writeBits(1, 1).writeBits(1, 1);
  writer.writeBits(descriptor, LOCAL_PALETTE_DESCRIPTOR_BITS);
}

export function writeLocalPaletteLength(writer: BitWriter, profile: number, length: number) {
  const size = paletteSize(profile);
  if (length <= 0 || length > size) throw new MCOImageV3InvalidInputError('Invalid local palette size');
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) writer.writeBits(length - 1, globalBits(profile));
  else if (length <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) writer.writeBits(0, 1).writeBits(length - 1, 6);
  else if (length <= LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT) writer.writeBits(1, 1).writeBits(0, 1).writeBits(length - 65, 6);
  else writer.writeBits(1, 1).writeBits(1, 1).writeBits(length - 129, bitLength(size - 129));
}

export function writeLocalPaletteDescriptorBody(writer: BitWriter, profile: number, colors: number[], descriptor: number) {
  if (descriptor === LOCAL_PALETTE_DESCRIPTOR_BITMAP) {
    const selected = new Set(colors.map((color) => colorRefForProfile(profile, color)));
    for (let ref = 0; ref < paletteSize(profile); ref++) writer.writeBits(selected.has(ref) ? 1 : 0, 1);
    return;
  }
  if (descriptor === LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA) {
    writeLocalPaletteLength(writer, profile, colors.length);
    let previous = colorRefForProfile(profile, colors[0]);
    writer.writeBits(previous, globalBits(profile));
    for (let i = 1; i < colors.length; i++) {
      const ref = colorRefForProfile(profile, colors[i]);
      writer.writeCompactUint(ref - previous - 1);
      previous = ref;
    }
    return;
  }
  if (descriptor === LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS) {
    const runs = localPaletteRefRanges(profile, colors);
    writer.writeRangeCompactUint(runs.length - 1, paletteSize(profile) - 1);
    for (const run of runs) writer.writeBits(run.start, globalBits(profile)).writeCompactUint(run.length - 1);
    return;
  }
  if (descriptor === LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS) {
    if (profile !== PaletteProfile.dynamicGlobal512) throw new MCOImageV3InvalidInputError('Bank bitmap descriptor requires dynamicGlobal512');
    writer.writeBits(LOCAL_PALETTE_BANK_DESCRIPTOR_BITMAPS, 1);
    const refs = colors.map((color) => colorRefForProfile(profile, color));
    const selected = new Set(refs);
    let bankMask = 0;
    for (const ref of refs) bankMask |= 1 << (ref >> 6);
    writer.writeBits(bankMask, 8);
    for (let bank = 0; bank < 8; bank++) if ((bankMask & (1 << bank)) !== 0) {
      for (let offset = 0; offset < 64; offset++) writer.writeBits(selected.has((bank << 6) | offset) ? 1 : 0, 1);
    }
    return;
  }
  if (descriptor === 4) {
    if (profile !== PaletteProfile.dynamicGlobal512) throw new MCOImageV3InvalidInputError('Ordered banked descriptor requires dynamicGlobal512');
    writer.writeBits(LOCAL_PALETTE_BANK_DESCRIPTOR_ORDERED_8X64, 1);
    writeLocalPaletteLength(writer, profile, colors.length);
    const refs = colors.map((color) => colorRefForProfile(profile, color));
    let bankMask = 0;
    for (const ref of refs) bankMask |= 1 << (ref >> 6);
    const banks = [];
    for (let bank = 0; bank < 8; bank++) if ((bankMask & (1 << bank)) !== 0) banks.push(bank);
    const single = banks.length === 1;
    writer.writeBits(single ? 0 : 1, 1);
    if (single) {
      writer.writeBits(banks[0], 3);
      for (const ref of refs) writer.writeBits(ref & 0x3f, 6);
    } else {
      writer.writeBits(bankMask, 8);
      const bankBits = bitLength(banks.length - 1);
      const indexes = new Map(banks.map((bank, index) => [bank, index]));
      for (const ref of refs) writer.writeBits(indexes.get(ref >> 6)!, bankBits).writeBits(ref & 0x3f, 6);
    }
    return;
  }
  throw new MCOImageV3InvalidInputError('Unsupported local palette descriptor');
}

export function writeLocalPalette(writer: BitWriter, profile: number, colors: number[]) {
  if (!Array.isArray(colors) || colors.length === 0 || colors.length > paletteSize(profile)) {
    throw new MCOImageV3InvalidInputError('Invalid local palette size');
  }
  const descriptor = bestLocalPaletteDescriptor(profile, colors);
  if (descriptor == null) {
    writeLocalPaletteFlatPrefix(writer, profile, colors.length);
    for (const color of colors) writeColorRef(writer, profile, color);
    return;
  }
  const wireDescriptor = descriptor === 4 ? LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS : descriptor;
  writeLocalPaletteDescriptorPrefix(writer, profile, wireDescriptor);
  writeLocalPaletteDescriptorBody(writer, profile, colors, descriptor);
}

export function firstUseLocalPalette(pixels: number[]) {
  const seen = new Set(), result = [];
  for (const pixel of pixels) if (!seen.has(pixel)) { seen.add(pixel); result.push(pixel); }
  return result;
}

export function profileOrderLocalPalette(pixels: number[], profile: number) {
  return Array.from(new Set(pixels)).sort((a, b) => (colorRefForProfile(profile, a) - colorRefForProfile(profile, b)) || (a - b));
}

export function transitionLocalPalette(pixels: number[], preferredFirstColor: number | null) {
  const colors = Array.from(new Set(pixels));
  if (colors.length < 2 || colors.length > 64) return null;
  const counts = new Map<number, number>(), edges = new Map<number, Map<number, number>>();
  for (const pixel of pixels) counts.set(pixel, (counts.get(pixel) || 0) + 1);
  const addEdge = (a: number, b: number) => {
    if (!edges.has(a)) edges.set(a, new Map());
    edges.get(a)!.set(b, (edges.get(a)!.get(b) || 0) + 1);
  };
  for (let i = 1; i < pixels.length; i++) {
    const a = pixels[i - 1], b = pixels[i];
    if (a !== b) { addEdge(a, b); addEdge(b, a); }
  }
  colors.sort((a, b) => (counts.get(b)! - counts.get(a)!) || (a - b));
  const remaining = new Set(colors);
  const first = preferredFirstColor != null && remaining.has(preferredFirstColor) ? preferredFirstColor : colors[0];
  const result = [first]; remaining.delete(first);
  while (remaining.size) {
    const previous = result[result.length - 1];
    let best: number | null = null, bestWeight = -1;
    for (const color of remaining) {
      const weight = edges.get(previous)?.get(color) || 0;
      if (best == null || weight > bestWeight ||
          (weight === bestWeight && ((counts.get(color) || 0) > (counts.get(best) || 0) ||
           ((counts.get(color) || 0) === (counts.get(best) || 0) && color < best)))) {
        best = color; bestWeight = weight;
      }
    }
    result.push(best as number); remaining.delete(best as number);
  }
  return result;
}


export function paletteRgbDistanceSquared(profile: number, left: number, right: number) {
  const a = paletteRgb(profile, left), b = paletteRgb(profile, right);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
}

export function rgbOrderLocalPalette(pixels: number[], profile: number, preferredFirstColor: number | null) {
  const colors = Array.from(new Set(pixels));
  if (colors.length < 3) return null;
  const counts = new Map<number, number>();
  for (const pixel of pixels) counts.set(pixel, (counts.get(pixel) || 0) + 1);
  const remaining = new Set(colors);
  let current: number;
  if (preferredFirstColor != null && remaining.has(preferredFirstColor)) current = preferredFirstColor;
  else current = colors.reduce((a, b) => (counts.get(a) || 0) >= (counts.get(b) || 0) ? a : b);
  const result = [];
  while (remaining.size) {
    result.push(current); remaining.delete(current);
    if (!remaining.size) break;
    let best: number | null = null;
    for (const color of remaining) {
      if (best == null) { best = color; continue; }
      const d = paletteRgbDistanceSquared(profile, current, color);
      const bd = paletteRgbDistanceSquared(profile, current, best);
      if (d < bd || (d === bd && ((counts.get(color) || 0) > (counts.get(best) || 0) ||
          ((counts.get(color) || 0) === (counts.get(best) || 0) && color < best)))) best = color;
    }
    current = best as number;
  }
  return result;
}

export function localPaletteVariants(pixels: number[], profile: number, options: EncodeOptions = {}) {
  const cacheKey = caches.localPaletteVariant == null ? null : [
    profile,
    options.indexOrderSensitive ? 1 : 0,
    options.includeTransitionOrder ? 1 : 0,
    options.includeBitplaneOptimizedOrder ? 1 : 0,
    options.includeRgbOrder ? 1 : 0,
    options.preferredFirstColor ?? '-',
    valueListCacheKey(pixels),
  ].join('|');
  if (cacheKey != null && caches.localPaletteVariant!.has(cacheKey)) {
    return caches.localPaletteVariant!.get(cacheKey)!;
  }
  const variants: number[][] = [], seen = new Set<string>();
  const add = (palette: number[] | null | undefined) => {
    if (!palette || palette.length === 0) return;
    const key = palette.join(',');
    if (!seen.has(key)) { seen.add(key); variants.push(palette); }
  };
  const frequency = localPalette(pixels);
  add(frequency);
  if (options.indexOrderSensitive && options.preferredFirstColor != null && frequency.includes(options.preferredFirstColor)) {
    add([options.preferredFirstColor, ...frequency.filter((color) => color !== options.preferredFirstColor)]);
  }
  if (options.indexOrderSensitive) add(firstUseLocalPalette(pixels));
  add(profileOrderLocalPalette(pixels, profile));
  if (options.indexOrderSensitive && options.includeTransitionOrder) add(transitionLocalPalette(pixels, options.preferredFirstColor ?? null));
  if (options.indexOrderSensitive && options.includeRgbOrder) add(rgbOrderLocalPalette(pixels, profile, options.preferredFirstColor ?? null));
  if (options.indexOrderSensitive && options.includeBitplaneOptimizedOrder) {
    for (const palette of bitplaneOptimizedLocalPalettes(pixels, profile, options.preferredFirstColor ?? null)) add(palette);
  }
  if (cacheKey != null) caches.localPaletteVariant!.set(cacheKey, variants);
  return variants;
}

export type LocalBodyWriter = (writer: BitWriter, localPixels: number[], bits: number) => void;

export function encodeLocalPaletteBlock(linear: number[], profile: number, palette: number[], writeBody: LocalBodyWriter) {
  const bits = localBits(palette.length);
  const localPixels = mapPixelsToPalette(linear, palette);
  const writer = new BitWriter();
  writeLocalPalette(writer, profile, palette);
  writeBody(writer, localPixels, bits);
  return { palette, localPixels, bits, bitLength: writer.bitLength, bytes: writer.toBytes() };
}

export function writeBestLocalPaletteBlock(writer: BitWriter, linear: number[], profile: number, options: EncodeOptions, writeBody: LocalBodyWriter) {
  let best: ReturnType<typeof encodeLocalPaletteBlock> | null = null;
  for (const palette of localPaletteVariants(linear, profile, options)) {
    try {
      const candidate = encodeLocalPaletteBlock(linear, profile, palette, writeBody);
      if (best == null || candidate.bitLength < best.bitLength) best = candidate;
    } catch (error) {
      if (!(error instanceof MCOImageV3CodecError)) throw error;
    }
  }
  if (best == null) throw new MCOImageV3InvalidInputError('Empty local palette');
  writer.writeBitStream(best.bytes, best.bitLength);
}


