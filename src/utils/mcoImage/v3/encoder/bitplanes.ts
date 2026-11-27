/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 2921-3094
 *          (adaptive bitplanes)
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
import { BitWriter } from './bitWriter.js';
import { localBits } from '../validate.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';
import { localPalette, mapPixelsToPalette } from './common.js';
import { profileOrderLocalPalette, rangeCompactUintBitLength, rgbOrderLocalPalette, transitionLocalPalette } from './localPaletteWriter.js';

export function buildBitplaneRuns(pixels: number[], bit: number) {
  if (pixels.length === 0) return [];
  const runs = [];
  let current = (pixels[0] >> bit) & 1, length = 1;
  for (let i = 1; i < pixels.length; i++) {
    const value = (pixels[i] >> bit) & 1;
    if (value === current) length++;
    else { runs.push(length); current = value; length = 1; }
  }
  runs.push(length);
  return runs;
}

export function residualRunLengthsBitCost(runs: number[], totalLength: number) {
  let cost = 0, consumed = 0;
  for (const length of runs) {
    if (length <= 0 || consumed + length > totalLength) throw new MCOImageV3InvalidInputError('Invalid residual run lengths');
    cost += rangeCompactUintBitLength(length - 1, totalLength - consumed - 1);
    consumed += length;
  }
  if (consumed !== totalLength) throw new MCOImageV3InvalidInputError('Residual run lengths do not fill the input');
  return cost;
}

export function writeResidualRunLengths(writer: BitWriter, runs: number[], totalLength: number) {
  let consumed = 0;
  for (const length of runs) {
    writer.writeRangeCompactUint(length - 1, totalLength - consumed - 1);
    consumed += length;
  }
  if (consumed !== totalLength) throw new MCOImageV3InvalidInputError('Residual run lengths do not fill the input');
}

export function shortBitplaneRunBitLength(length: number, remainingLength: number) {
  if (length <= 0 || remainingLength <= 0 || length > remainingLength) throw new MCOImageV3InvalidInputError('Invalid bitplane run');
  if (length <= 3) return length;
  return 3 + rangeCompactUintBitLength(length - 4, remainingLength - 4);
}

export function shortBitplaneRunsBitCost(runs: number[], totalLength: number) {
  let cost = 0, consumed = 0;
  for (const length of runs) { cost += shortBitplaneRunBitLength(length, totalLength - consumed); consumed += length; }
  if (consumed !== totalLength) throw new MCOImageV3InvalidInputError('Short bitplane runs do not fill the input');
  return cost;
}

export function writeShortBitplaneRunLength(writer: BitWriter, length: number, remainingLength: number) {
  if (length <= 3) writer.writeBits((1 << (length - 1)) - 1, length);
  else writer.writeBits(7, 3).writeRangeCompactUint(length - 4, remainingLength - 4);
}

export function sparseBitplanePositionCost(positions: number[], pixelCount: number) {
  let cost = rangeCompactUintBitLength(positions.length - 1, pixelCount - 1), previous = -1;
  for (let i = 0; i < positions.length; i++) {
    const remainingPositions = positions.length - i - 1;
    const maxGap = pixelCount - previous - remainingPositions - 2;
    cost += rangeCompactUintBitLength(positions[i] - previous - 1, maxGap);
    previous = positions[i];
  }
  return cost;
}

export function writeSparseBitplanePositions(writer: BitWriter, positions: number[], pixelCount: number) {
  writer.writeRangeCompactUint(positions.length - 1, pixelCount - 1);
  let previous = -1;
  for (let i = 0; i < positions.length; i++) {
    const remainingPositions = positions.length - i - 1;
    const maxGap = pixelCount - previous - remainingPositions - 2;
    writer.writeRangeCompactUint(positions[i] - previous - 1, maxGap);
    previous = positions[i];
  }
}

export interface BitplaneDecision {
  mode: string;
  bitCost: number;
  startingBit: number;
  runs: number[];
  minorityPositions: number[];
}

export function chooseAdaptiveBitplaneEncoding(pixels: number[], bit: number) {
  if (pixels.length === 0) throw new MCOImageV3InvalidInputError('Adaptive bitplanes require at least one pixel');
  const runs = buildBitplaneRuns(pixels, bit);
  const startingBit = (pixels[0] >> bit) & 1;
  const onePositions: number[] = [], zeroPositions: number[] = [];
  for (let i = 0; i < pixels.length; i++) (((pixels[i] >> bit) & 1) === 0 ? zeroPositions : onePositions).push(i);
  const decisions: BitplaneDecision[] = [
    { mode: 'raw', bitCost: 1 + pixels.length, startingBit, runs, minorityPositions: [] },
    { mode: 'legacyRle', bitCost: 3 + residualRunLengthsBitCost(runs, pixels.length), startingBit, runs, minorityPositions: [] },
    { mode: 'shortRle', bitCost: 4 + shortBitplaneRunsBitCost(runs, pixels.length), startingBit, runs, minorityPositions: [] },
  ];
  if (onePositions.length === 0 || zeroPositions.length === 0) {
    decisions.push({ mode: onePositions.length === 0 ? 'constantZero' : 'constantOne', bitCost: 5, startingBit, runs, minorityPositions: [] });
  } else {
    decisions.push({ mode: 'sparseOne', bitCost: 5 + sparseBitplanePositionCost(onePositions, pixels.length), startingBit, runs, minorityPositions: onePositions });
    decisions.push({ mode: 'sparseZero', bitCost: 5 + sparseBitplanePositionCost(zeroPositions, pixels.length), startingBit, runs, minorityPositions: zeroPositions });
  }
  let best = decisions[0];
  for (let i = 1; i < decisions.length; i++) if (decisions[i].bitCost < best.bitCost) best = decisions[i];
  return best;
}

export function writeAdaptiveBitplanesBody(writer: BitWriter, pixels: number[], bits: number) {
  for (let bit = 0; bit < bits; bit++) {
    const d = chooseAdaptiveBitplaneEncoding(pixels, bit);
    if (d.mode === 'raw') {
      writer.writeBits(0, 1);
      for (const pixel of pixels) writer.writeBits((pixel >> bit) & 1, 1);
    } else if (d.mode === 'legacyRle') {
      writer.writeBits(1, 2).writeBits(d.startingBit, 1);
      writeResidualRunLengths(writer, d.runs, pixels.length);
    } else if (d.mode === 'shortRle') {
      writer.writeBits(3, 3).writeBits(d.startingBit, 1);
      let consumed = 0;
      for (const length of d.runs) { writeShortBitplaneRunLength(writer, length, pixels.length - consumed); consumed += length; }
    } else if (d.mode === 'constantZero') writer.writeBits(7, 5);
    else if (d.mode === 'constantOne') writer.writeBits(15, 5);
    else if (d.mode === 'sparseOne') { writer.writeBits(23, 5); writeSparseBitplanePositions(writer, d.minorityPositions, pixels.length); }
    else if (d.mode === 'sparseZero') { writer.writeBits(31, 5); writeSparseBitplanePositions(writer, d.minorityPositions, pixels.length); }
  }
}

export function adaptiveBitplanesCost(pixels: number[], palette: number[]) {
  const local = mapPixelsToPalette(pixels, palette);
  let cost = 0;
  for (let bit = 0; bit < localBits(palette.length); bit++) cost += chooseAdaptiveBitplaneEncoding(local, bit).bitCost;
  return cost;
}

export function optimizeBitplanesPaletteOrder(pixels: number[], palette: number[]) {
  let bestPalette = Array.from(palette), bestCost = adaptiveBitplanesCost(pixels, bestPalette);
  const exhaustive = palette.length <= 8, passCount = exhaustive ? 2 : 1;
  for (let pass = 0; pass < passCount; pass++) {
    let improved = false, passPalette = bestPalette, passCost = bestCost;
    for (let left = 0; left < bestPalette.length - 1; left++) {
      const rightLimit = exhaustive ? bestPalette.length : left + 2;
      for (let right = left + 1; right < rightLimit; right++) {
        const candidate = Array.from(bestPalette);
        [candidate[left], candidate[right]] = [candidate[right], candidate[left]];
        const cost = adaptiveBitplanesCost(pixels, candidate);
        if (cost < passCost) { passPalette = candidate; passCost = cost; improved = true; }
      }
    }
    if (!improved) break;
    bestPalette = passPalette; bestCost = passCost;
  }
  return bestPalette;
}

export function bitplaneOptimizedLocalPalettes(pixels: number[], profile: number, preferredFirstColor: number | null) {
  const base = localPalette(pixels);
  if (base.length < 2) return [];
  const backgroundFirst = preferredFirstColor != null && base.includes(preferredFirstColor)
    ? [preferredFirstColor, ...base.filter((color) => color !== preferredFirstColor)] : null;
  const seeds = [base, backgroundFirst, profileOrderLocalPalette(pixels, profile),
    preferredFirstColor != null ? (rgbOrderLocalPalette(pixels, profile, preferredFirstColor) || base) : null,
    transitionLocalPalette(pixels, preferredFirstColor) || base].filter((seed): seed is number[] => seed != null);
  const result: number[][] = [], seenSeed = new Set<string>(), seenResult = new Set<string>();
  for (const seed of seeds) {
    const key = seed.join(','); if (seenSeed.has(key)) continue; seenSeed.add(key);
    const optimized = optimizeBitplanesPaletteOrder(pixels, seed), outKey = optimized.join(',');
    if (!seenResult.has(outKey)) { seenResult.add(outKey); result.push(optimized); }
  }
  return result;
}

export function writeLegacyBitplanesBody(writer: BitWriter, localPixels: number[], bits: number) {
  for (let bit = 0; bit < bits; bit++) {
    const runs = buildBitplaneRuns(localPixels, bit);
    const rleBits = 2 + residualRunLengthsBitCost(runs, localPixels.length);
    const rawBits = 1 + localPixels.length;
    if (rleBits < rawBits) {
      writer.writeBits(1, 1).writeBits((localPixels[0] >> bit) & 1, 1);
      writeResidualRunLengths(writer, runs, localPixels.length);
    } else {
      writer.writeBits(0, 1);
      for (const pixel of localPixels) writer.writeBits((pixel >> bit) & 1, 1);
    }
  }
}

