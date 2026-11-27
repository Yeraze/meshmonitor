/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 3563-3705
 *          (greedy and optimal LZ)
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
import type { LzToken } from './types.js';
import { BitWriter } from './bitWriter.js';
import {
  MIN_LZ_MATCH_LENGTH,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';
import { valueListCacheKey } from './common.js';
import { rangeCompactUintBitLength } from './localPaletteWriter.js';
import { caches } from './common.js';

export function lzKey(pixels: number[], position: number, localBits: number) {
  return ((pixels[position] << (localBits * 2)) | (pixels[position + 1] << localBits) | pixels[position + 2]);
}

export function addLzPosition(map: Map<number, number[]>, pixels: number[], position: number, localBits: number) {
  if (position + MIN_LZ_MATCH_LENGTH > pixels.length) return;
  const key = lzKey(pixels, position, localBits);
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(position);
  if (list.length > 32) list.shift();
}

export function buildGreedyLzTokens(pixels: number[], localBits: number) {
  const cacheKey = caches.lzToken == null ? null : `g|${localBits}|${valueListCacheKey(pixels)}`;
  if (cacheKey != null && caches.lzToken!.has(cacheKey)) return caches.lzToken!.get(cacheKey)!;
  const tokens: LzToken[] = [], pending: number[] = [], positions = new Map<number, number[]>();
  const flush = () => { if (pending.length) tokens.push({ isMatch: false, literals: pending.splice(0) }); };
  let position = 0;
  while (position < pixels.length) {
    let bestLength = 0, bestDistance = 0;
    if (position + MIN_LZ_MATCH_LENGTH <= pixels.length) {
      const candidates = positions.get(lzKey(pixels, position, localBits));
      if (candidates) for (let i = candidates.length - 1; i >= 0; i--) {
        const previous = candidates[i], distance = position - previous;
        let length = MIN_LZ_MATCH_LENGTH;
        while (position + length < pixels.length && pixels[previous + length] === pixels[position + length]) length++;
        if (length > bestLength || (length === bestLength && (bestDistance === 0 || distance < bestDistance))) {
          bestLength = length; bestDistance = distance;
        }
      }
    }
    const remaining = pixels.length - position;
    const matchBits = bestLength >= MIN_LZ_MATCH_LENGTH
      ? 1 + rangeCompactUintBitLength(bestDistance - 1, position - 1) +
        rangeCompactUintBitLength(bestLength - MIN_LZ_MATCH_LENGTH, remaining - MIN_LZ_MATCH_LENGTH)
      : 0;
    const literalBits = bestLength >= MIN_LZ_MATCH_LENGTH
      ? 1 + rangeCompactUintBitLength(bestLength - 1, remaining - 1) + bestLength * localBits
      : 0;
    if (bestLength >= MIN_LZ_MATCH_LENGTH && matchBits < literalBits) {
      flush();
      tokens.push({ isMatch: true, distance: bestDistance, length: bestLength, literals: [] });
      for (let i = 0; i < bestLength; i++) addLzPosition(positions, pixels, position + i, localBits);
      position += bestLength;
    } else {
      pending.push(pixels[position]);
      addLzPosition(positions, pixels, position, localBits);
      position++;
    }
  }
  flush();
  if (cacheKey != null) caches.lzToken!.set(cacheKey, tokens);
  return tokens;
}

export function lzTokensBitCost(tokens: LzToken[], localBits: number, totalLength: number) {
  let cost = 0, produced = 0;
  for (const token of tokens) {
    const remaining = totalLength - produced;
    if (token.isMatch) {
      cost += 1 + rangeCompactUintBitLength(token.distance - 1, produced - 1) +
        rangeCompactUintBitLength(token.length - MIN_LZ_MATCH_LENGTH, remaining - MIN_LZ_MATCH_LENGTH);
      produced += token.length;
    } else {
      cost += 1 + rangeCompactUintBitLength(token.literals.length - 1, remaining - 1) + token.literals.length * localBits;
      produced += token.literals.length;
    }
  }
  return cost;
}

export function buildOptimalLzTokens(pixels: number[], localBits: number): LzToken[] | null {
  const cacheKey = caches.lzToken == null ? null : `o|${localBits}|${valueListCacheKey(pixels)}`;
  if (cacheKey != null && caches.lzToken!.has(cacheKey)) return caches.lzToken!.get(cacheKey)!;
  const n = pixels.length;
  if (n === 0) return [];
  const dp: number[] = new Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const step: Array<{ end: number; distance: number } | null> = new Array(n).fill(null);
  dp[n] = 0;
  for (let pos = n - 1; pos >= 0; pos--) {
    const remaining = n - pos;
    for (let length = 1; length <= remaining; length++) {
      const cost = 1 + rangeCompactUintBitLength(length - 1, remaining - 1) + length * localBits + dp[pos + length];
      if (cost < dp[pos] || (cost === dp[pos] && (!step[pos] || pos + length > step[pos]!.end))) {
        dp[pos] = cost; step[pos] = { end: pos + length, distance: 0 };
      }
    }
    if (pos + MIN_LZ_MATCH_LENGTH > n || pos === 0) continue;
    const bestByDistanceCost = new Map<number, { distance: number; maxLength: number; distanceCost: number }>();
    for (let previous = pos - 1; previous >= 0; previous--) {
      if (pixels[previous] !== pixels[pos] || pixels[previous + 1] !== pixels[pos + 1] || pixels[previous + 2] !== pixels[pos + 2]) continue;
      const distance = pos - previous;
      let maxLength = MIN_LZ_MATCH_LENGTH;
      while (pos + maxLength < n && pixels[pos + maxLength - distance] === pixels[pos + maxLength]) maxLength++;
      const distanceCost = rangeCompactUintBitLength(distance - 1, pos - 1);
      const existing = bestByDistanceCost.get(distanceCost);
      if (!existing || maxLength > existing.maxLength || (maxLength === existing.maxLength && distance < existing.distance)) {
        bestByDistanceCost.set(distanceCost, { distance, maxLength, distanceCost });
      }
    }
    for (const match of bestByDistanceCost.values()) {
      for (let length = MIN_LZ_MATCH_LENGTH; length <= match.maxLength; length++) {
        const cost = 1 + match.distanceCost +
          rangeCompactUintBitLength(length - MIN_LZ_MATCH_LENGTH, remaining - MIN_LZ_MATCH_LENGTH) + dp[pos + length];
        if (cost < dp[pos] || (cost === dp[pos] && (!step[pos] || pos + length > step[pos]!.end))) {
          dp[pos] = cost; step[pos] = { end: pos + length, distance: match.distance };
        }
      }
    }
  }
  if (!step[0]) return null;
  const tokens: LzToken[] = [];
  let position = 0;
  while (position < n) {
    const s = step[position];
    if (!s || s.end <= position) return null;
    if (s.distance === 0) tokens.push({ isMatch: false, literals: pixels.slice(position, s.end) });
    else tokens.push({ isMatch: true, distance: s.distance, length: s.end - position, literals: [] });
    position = s.end;
  }
  if (cacheKey != null) caches.lzToken!.set(cacheKey, tokens);
  return tokens;
}

export function writeLzTokens(writer: BitWriter, tokens: LzToken[], localBits: number, totalLength: number) {
  let produced = 0;
  for (const token of tokens) {
    const remaining = totalLength - produced;
    if (token.isMatch) {
      writer.writeBits(1, 1);
      writer.writeRangeCompactUint(token.distance - 1, produced - 1);
      writer.writeRangeCompactUint(token.length - MIN_LZ_MATCH_LENGTH, remaining - MIN_LZ_MATCH_LENGTH);
      produced += token.length;
    } else {
      writer.writeBits(0, 1);
      writer.writeRangeCompactUint(token.literals.length - 1, remaining - 1);
      for (const value of token.literals) writer.writeBits(value, localBits);
      produced += token.literals.length;
    }
  }
  if (produced !== totalLength) throw new MCOImageV3InvalidInputError('LZ tokens do not fill block');
}
