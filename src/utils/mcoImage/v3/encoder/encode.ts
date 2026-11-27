/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 5064-5135, 5137-5318, 5434-5448, 5554-5564, 5592-5594
 *          (candidate comparison, finalise, background and scan normalisation, cache reset, runV3Encode, public encode, packet nonce, text; Extreme, worker partitioning, diagnostics and progress are not ported)
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
import type { V3Image, Candidate, BackgroundCandidate } from './types.js';
import { canUseCompactBlockHeader } from '../validate.js';
import { whiteIndexFor } from '../palettes.js';
import { rowLengthForScan } from '../blockBodies.js';
import {
  MAX_REGIONS,
  McoImageV3ContainerName,
  ScanMode,
  SUBTYPE_VERSION,
  TEXT_PREFIX,
} from '../constants.js';
import type { PaletteProfileId, ScanModeId, McoImageV3BlockAlgorithmId } from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';
import { McoImageV3BlockAlgorithm as MCOImageV3BlockAlgorithm } from '../constants.js';
import { base91Encode } from '../../base91.js';
import { tryBuildBlockBodyEncoding, tryBuildSolidBackgroundCandidate, tryBuildSolidRectsCandidate, tryBuildTopLevelCandidate, tryWrapBoundsCandidate } from './blockBody.js';
import { boundsForBackground, caches, extractBoundsPixels, fullBackgroundCandidates, isColorValid, modeTieRank, normalBackgroundCandidates, toScanOrder, validateImageForEncode, withPacketNonce } from './common.js';
import { regionVariantsEncoder, tryBuildRegionsCandidateEncoder } from './regions.js';
import { FULL_BLOCK_ALGORITHMS, FULL_REGION_OPTIONS, FULL_TOP_LEVEL_BACKGROUND_INDEPENDENT, NORMAL_BLOCK_ALGORITHMS, NORMAL_MAX_REGIONS, NORMAL_REGION_OPTIONS, NORMAL_TOP_LEVEL_BACKGROUND_INDEPENDENT, TOP_LEVEL_BACKGROUND_SENSITIVE } from './tables.js';

export type McoV3Level = 'normal' | 'high';

export interface McoV3EncodeInput {
  width: number;
  height: number;
  paletteProfile: PaletteProfileId;
  /** Profile indexes (fixed profiles) or Dynamic Global 512 indexes (dynamic profiles). */
  pixels: ArrayLike<number>;
  transparentColor?: number | null;
}

export interface McoV3EncodeResult {
  /** Nonce byte followed by the v3 body (upstream `payload`). */
  body: Uint8Array;
  bodyWithoutNonce: Uint8Array;
  /** `im3:` followed by Base91(0x13 | body). */
  text: string;
  /** Upstream `modeName`, e.g. `regionsBg`. */
  mode: string;
  /** Container id (`McoImageV3Container`). */
  container: number;
  /** Block algorithm id; null for region candidates (upstream `algorithm: null`). */
  algorithm: McoImageV3BlockAlgorithmId | null;
  scan: ScanModeId;
}

export function compareEncoderCandidates(a: Candidate, b: Candidate) {
  const byBytes = a.byteLength - b.byteLength;
  if (byBytes) return byBytes;
  return modeTieRank(a.mode) - modeTieRank(b.mode);
}

export function finalizeEncodedCandidate(candidate: Candidate, nonce: number) {
  const packet = withPacketNonce(candidate, nonce);
  const appPayload = new Uint8Array(packet.payload.length + 1);
  appPayload[0] = SUBTYPE_VERSION;
  appPayload.set(packet.payload, 1);
  const text = `${TEXT_PREFIX}${base91Encode(appPayload)}`;
  return Object.freeze({ ...packet, body: packet.payload, payload: packet.payload, appPayloadWithoutSender: appPayload, text, charLength: text.length });
}

export function normalizedBackgroundsForEncode(image: V3Image, high: boolean, preferred: number) {
  const source: BackgroundCandidate[] = high
    ? fullBackgroundCandidates(image, preferred, true)
    : normalBackgroundCandidates(image, preferred);
  const result: BackgroundCandidate[] = [];
  for (const item of source) {
    if (!Number.isInteger(item.color) || !isColorValid(image.paletteProfile, item.color)) continue;
    const rank = Number.isFinite(item.rank) ? Math.trunc(item.rank) : result.length;
    result.push(Object.freeze({ color: item.color, rank }));
  }
  return result;
}

export function normalizedScansForEncode(high: boolean) {
  const source = high ? [ScanMode.h, ScanMode.v, ScanMode.s, ScanMode.sv] : [ScanMode.h, ScanMode.v, ScanMode.s];
  const result: ScanModeId[] = [];
  for (const scan of source) {
    if (!Number.isInteger(scan) || scan < ScanMode.h || scan > ScanMode.sv) {
      throw new MCOImageV3InvalidInputError('Invalid scan mode');
    }
    if (!result.includes(scan)) result.push(scan);
  }
  return result;
}

export function resetV3EncoderCaches() {
  caches.regionBody = new Map();
  caches.regionLayoutCost = new Map();
  caches.regionPlan = new Map();
  caches.localIndexMap = new Map();
  caches.localPixels = new Map();
  caches.runs = new Map();
  caches.sparseAnalysis = new Map();
  caches.localPaletteVariant = new Map();
  caches.lzToken = new Map();
}

export function clearV3EncoderCaches() {
  caches.regionBody?.clear();
  caches.regionLayoutCost?.clear();
  caches.regionPlan?.clear();
  caches.localIndexMap?.clear();
  caches.localPixels?.clear();
  caches.runs?.clear();
  caches.sparseAnalysis?.clear();
  caches.localPaletteVariant?.clear();
  caches.lzToken?.clear();
  caches.regionBody = null;
  caches.regionLayoutCost = null;
  caches.regionPlan = null;
  caches.localIndexMap = null;
  caches.localPixels = null;
  caches.runs = null;
  caches.sparseAnalysis = null;
  caches.localPaletteVariant = null;
  caches.lzToken = null;
}

export interface RunV3EncodeOptions {
  high: boolean;
  packetNonce: number;
  backgroundColor?: number | null;
}

export function runV3Encode(imageLike: McoV3EncodeInput, options: RunV3EncodeOptions) {
  const image = validateImageForEncode(imageLike);
  const high = options.high;
  const preferred = options.backgroundColor ?? image.transparentColor ?? whiteIndexFor(image.paletteProfile);
  const backgrounds = normalizedBackgroundsForEncode(image, high, preferred);
  const scans = normalizedScansForEncode(high);
  const nonce = Number(options.packetNonce);
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 255) {
    throw new MCOImageV3InvalidInputError('packetNonce must be 0..255');
  }
  resetV3EncoderCaches();
  // Output-neutral speed change (#6586): rejected candidates throw control-flow
  // errors that are caught and discarded; skip capturing a stack for each.
  const errorCtor = Error as ErrorConstructor & { stackTraceLimit?: number };
  const previousStackTraceLimit = errorCtor.stackTraceLimit;
  errorCtor.stackTraceLimit = 0;
  try {
    let best: Candidate | null = null;
    const seen = new Map<string, Candidate>();
    const add = (candidate: Candidate | null) => {
      if (!candidate) return;
      const key = bytesKey(candidate.payload);
      const existing = seen.get(key);
      if (!existing || compareEncoderCandidates(candidate, existing) < 0) seen.set(key, candidate);
      if (!best || compareEncoderCandidates(candidate, best) < 0) best = candidate;
    };

    const processSolid = () => {
      add(tryBuildSolidBackgroundCandidate(image));
    };

    const processBackground = (background: BackgroundCandidate) => {
      const bg = background.color;
      add(tryBuildSolidRectsCandidate(image, bg, background.rank));
      const maxRegions = high ? MAX_REGIONS : NORMAL_MAX_REGIONS;
      const variants = regionVariantsEncoder(image, bg, maxRegions, high);
      for (const variant of variants) {
        add(tryBuildRegionsCandidateEncoder(image, bg, background.rank, variant.regions, {
          compactGeometry: false,
          commonBlockHeader: false,
          hybridCommonHeader: false,
          deltaGeometry: false,
          sharedLocalPalette: false,
        }, high, variant.planCache));
        const regionOptions = high ? FULL_REGION_OPTIONS : NORMAL_REGION_OPTIONS;
        for (const regionOption of regionOptions) {
          add(tryBuildRegionsCandidateEncoder(image, bg, background.rank, variant.regions, {
            compactGeometry: true,
            ...regionOption,
          }, high, variant.planCache));
        }
      }
      const bounds = boundsForBackground(image, bg);
      if (bounds && !(bounds.width === image.width && bounds.height === image.height)) {
        const cropped = extractBoundsPixels(image, bounds);
        for (const scan of scans) {
          const linear = toScanOrder(cropped, bounds.width, bounds.height, scan);
          for (const algorithm of (high ? FULL_BLOCK_ALGORITHMS : NORMAL_BLOCK_ALGORITHMS)) {
            if (algorithm === MCOImageV3BlockAlgorithm.quadtree && scan !== ScanMode.h) continue;
            const body = tryBuildBlockBodyEncoding(image, linear, algorithm, {
              backgroundColor: bg,
              rowLength: rowLengthForScan(scan, bounds.width, bounds.height),
              backgroundInherited: true,
              greedyLzOnly: !high,
              useHighCompressionExtras: high,
            });
            if (!body) continue;
            add(tryWrapBoundsCandidate(image, bounds, linear, body, algorithm, scan, {
              backgroundColor: bg,
              compactGeometry: false,
              backgroundRank: background.rank,
            }));
            add(tryWrapBoundsCandidate(image, bounds, linear, body, algorithm, scan, {
              backgroundColor: bg,
              compactGeometry: true,
              backgroundRank: background.rank,
            }));
          }
        }
      }
    };

    const independent = high
      ? FULL_TOP_LEVEL_BACKGROUND_INDEPENDENT
      : NORMAL_TOP_LEVEL_BACKGROUND_INDEPENDENT;
    const processScanIndependent = (scan: ScanModeId) => {
      const linear = toScanOrder(image.pixels, image.width, image.height, scan);
      for (const algorithm of independent) {
        if (canUseCompactBlockHeader(algorithm)) {
          if (scan === ScanMode.h) add(tryBuildTopLevelCandidate(image, linear, algorithm, scan, {
            backgroundColor: preferred,
            compactHeader: true,
            greedyLzOnly: !high,
            useHighCompressionExtras: high,
          }));
        } else {
          add(tryBuildTopLevelCandidate(image, linear, algorithm, scan, {
            backgroundColor: preferred,
            compactHeader: false,
            greedyLzOnly: !high,
            useHighCompressionExtras: high,
          }));
        }
      }
    };

    const processScanBackgroundSensitive = (scan: ScanModeId, background: BackgroundCandidate) => {
      const linear = toScanOrder(image.pixels, image.width, image.height, scan);
      for (const algorithm of TOP_LEVEL_BACKGROUND_SENSITIVE) {
        if (canUseCompactBlockHeader(algorithm)) {
          if (scan === ScanMode.h) add(tryBuildTopLevelCandidate(image, linear, algorithm, scan, {
            backgroundColor: background.color,
            compactHeader: true,
            greedyLzOnly: !high,
            useHighCompressionExtras: high,
          }));
        } else {
          add(tryBuildTopLevelCandidate(image, linear, algorithm, scan, {
            backgroundColor: background.color,
            compactHeader: false,
            greedyLzOnly: !high,
            useHighCompressionExtras: high,
          }));
        }
      }
    };

    processSolid();
    for (const background of backgrounds) processBackground(background);
    for (const scan of scans) {
      processScanIndependent(scan);
      for (const background of backgrounds) processScanBackgroundSensitive(scan, background);
    }

    if (!best) {
      throw new MCOImageV3InvalidInputError('No MCOimg v3 candidate');
    }
    const sorted = Array.from(seen.values()).sort(compareEncoderCandidates);
    return finalizeEncodedCandidate(sorted[0], nonce);
  } finally {
    clearV3EncoderCaches();
    errorCtor.stackTraceLimit = previousStackTraceLimit;
  }
}

/** Exact key for a payload: one char per byte. Same identity as upstream's `join(',')`. */
function bytesKey(bytes: Uint8Array): string {
  let key = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    key += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return key;
}

/** Encode one image at the Normal or High level (upstream `MCOImageV3Codec.encode`). */
export function encodeV3(image: McoV3EncodeInput, opts: { level: McoV3Level; packetNonce: number }): McoV3EncodeResult {
  const result = runV3Encode(image, { high: opts.level === 'high', packetNonce: opts.packetNonce });
  return {
    body: result.payload,
    bodyWithoutNonce: result.payload.subarray(1),
    text: result.text,
    mode: result.modeName,
    container: McoImageV3ContainerName.indexOf(result.container as (typeof McoImageV3ContainerName)[number]),
    algorithm: result.algorithm,
    scan: result.scan,
  };
}

let packetNonceCounter = (Date.now() ^ Math.floor(Math.random() * 256)) & 0xff;
let lastPacketNonce: number | null = null;

/** Upstream `MCOImageV3Codec.nextPacketNonce`. */
export function nextPacketNonce() {
  packetNonceCounter = (packetNonceCounter + 1) & 0xff;
  let mixed = Date.now() ^ (packetNonceCounter * 0x9d);
  mixed ^= mixed >>> 8;
  mixed ^= mixed >>> 16;
  let nonce = mixed & 0xff;
  if (nonce === lastPacketNonce) nonce = (nonce + 1) & 0xff;
  lastPacketNonce = nonce;
  return nonce;
}

/** Test-only re-exports for the internal-entry fixtures (regions-*, boundsBlock-*). */
export { tryBuildRegionsCandidateEncoder } from './regions.js';
export { tryWrapBoundsCandidate, tryBuildBlockBodyEncoding } from './blockBody.js';
