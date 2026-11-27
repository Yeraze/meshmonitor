/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 1865-1873, 1884-2044
 *          (encoder constants and algorithm tables; the MAX_EXTREME_* / EXTREME_* constants (1874-1883) are not ported)
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
import { McoImageV3BlockAlgorithm as MCOImageV3BlockAlgorithm } from '../constants.js';

export const NORMAL_MAX_REGIONS = 12;
export const MAX_FREQUENT_BACKGROUND_CANDIDATES = 8;
export const MAX_NORMAL_BACKGROUND_CANDIDATES = 4;
export const MAX_EXHAUSTIVE_BACKGROUND_COLORS = 64;
export const MAX_EXHAUSTIVE_BACKGROUND_PIXELS = 4096;
export const MAX_BEAM_REGION_PIXELS = 4096;
export const REGION_BEAM_WIDTH = 3;
export const REGION_BEAM_DEPTH = 2;
export const REGION_BEAM_NEIGHBORS = 8;

export const MAX_LZ_MATCH_CANDIDATES = 48;
export const MAX_OPTIMAL_LZ_PIXELS = 1024;

export const ImageMode = Object.freeze({
  rawGlobal: 0,
  rawLocal: 1,
  rleLocal: 2,
  sparseBg: 3,
  regionsBg: 4,
  biColorMask: 5,
  rowDelta: 6,
  rowRepeat: 7,
  extended: 8,
});
export const ImageModeName = Object.freeze([
  'rawGlobal', 'rawLocal', 'rleLocal', 'sparseBg', 'regionsBg',
  'biColorMask', 'rowDelta', 'rowRepeat', 'extended',
]);

export const NORMAL_BLOCK_ALGORITHMS = Object.freeze([
  MCOImageV3BlockAlgorithm.rawGlobal,
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.biColorMask,
]);
export const FULL_BLOCK_ALGORITHMS = Object.freeze([
  MCOImageV3BlockAlgorithm.rawGlobal,
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.directBitplanes,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.directRowDelta,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.biColorMask,
]);
export const NORMAL_TOP_LEVEL_BACKGROUND_INDEPENDENT = Object.freeze([
  MCOImageV3BlockAlgorithm.rawGlobal,
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.rowRepeat,
]);
export const FULL_TOP_LEVEL_BACKGROUND_INDEPENDENT = Object.freeze([
  MCOImageV3BlockAlgorithm.rawGlobal,
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.directBitplanes,
  MCOImageV3BlockAlgorithm.directRowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
]);
export const TOP_LEVEL_BACKGROUND_SENSITIVE = Object.freeze([
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.biColorMask,
]);
export const NORMAL_REGION_BLOCK_ALGORITHMS = Object.freeze([
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.biColorMask,
]);
export const FULL_REGION_BLOCK_ALGORITHMS = Object.freeze([
  MCOImageV3BlockAlgorithm.rawGlobal,
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.directBitplanes,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.directRowDelta,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.biColorMask,
]);
export const NORMAL_SHARED_REGION_ALGORITHMS = NORMAL_REGION_BLOCK_ALGORITHMS;
export const FULL_SHARED_REGION_ALGORITHMS = Object.freeze([
  MCOImageV3BlockAlgorithm.rawLocal,
  MCOImageV3BlockAlgorithm.compactRle,
  MCOImageV3BlockAlgorithm.varUintRle,
  MCOImageV3BlockAlgorithm.compactSparse,
  MCOImageV3BlockAlgorithm.varUintSparse,
  MCOImageV3BlockAlgorithm.lzPixels,
  MCOImageV3BlockAlgorithm.quadtree,
  MCOImageV3BlockAlgorithm.bitplanes,
  MCOImageV3BlockAlgorithm.adaptiveBitplanes,
  MCOImageV3BlockAlgorithm.compactRowDelta,
  MCOImageV3BlockAlgorithm.rowDelta,
  MCOImageV3BlockAlgorithm.rowRepeat,
  MCOImageV3BlockAlgorithm.biColorMask,
]);

export const NORMAL_REGION_OPTIONS = Object.freeze([
  { commonBlockHeader: false, hybridCommonHeader: false, deltaGeometry: false, sharedLocalPalette: false },
  { commonBlockHeader: false, hybridCommonHeader: false, deltaGeometry: true, sharedLocalPalette: false },
  { commonBlockHeader: false, hybridCommonHeader: false, deltaGeometry: false, sharedLocalPalette: true },
  { commonBlockHeader: false, hybridCommonHeader: false, deltaGeometry: true, sharedLocalPalette: true },
  { commonBlockHeader: true, hybridCommonHeader: false, deltaGeometry: false, sharedLocalPalette: false },
  { commonBlockHeader: true, hybridCommonHeader: false, deltaGeometry: true, sharedLocalPalette: false },
  { commonBlockHeader: true, hybridCommonHeader: false, deltaGeometry: false, sharedLocalPalette: true },
  { commonBlockHeader: true, hybridCommonHeader: false, deltaGeometry: true, sharedLocalPalette: true },
]);
export const FULL_REGION_OPTIONS = Object.freeze([
  ...NORMAL_REGION_OPTIONS,
  { commonBlockHeader: true, hybridCommonHeader: true, deltaGeometry: false, sharedLocalPalette: false },
  { commonBlockHeader: true, hybridCommonHeader: true, deltaGeometry: true, sharedLocalPalette: false },
  { commonBlockHeader: true, hybridCommonHeader: true, deltaGeometry: false, sharedLocalPalette: true },
  { commonBlockHeader: true, hybridCommonHeader: true, deltaGeometry: true, sharedLocalPalette: true },
]);

