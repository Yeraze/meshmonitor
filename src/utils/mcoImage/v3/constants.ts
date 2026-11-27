/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 8-75 and 109-159 (enums, header and bit constants)
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file line for line; only types were added.
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
export const PaletteProfile = {
  mono: 0,
  master4: 1,
  master8: 2,
  master16: 3,
  master32: 4,
  master64: 5,
  grayscale16: 6,
  grayscale32: 7,
  grayscale8: 8,
  dynamicGlobal8: 9,
  dynamicGlobal16: 10,
  dynamicGlobal32: 11,
  dynamicGlobal64: 12,
  dynamicGlobal128: 13,
  dynamicGlobal256: 14,
  dynamicGlobal512: 15,
} as const;

export const PaletteProfileName = [
  'mono', 'master4', 'master8', 'master16', 'master32', 'master64',
  'grayscale16', 'grayscale32', 'grayscale8', 'dynamicGlobal8',
  'dynamicGlobal16', 'dynamicGlobal32', 'dynamicGlobal64',
  'dynamicGlobal128', 'dynamicGlobal256', 'dynamicGlobal512',
] as const;

export const ScanMode = { h: 0, v: 1, s: 2, sv: 3 } as const;
export const ScanModeName = ['h', 'v', 's', 'sv'] as const;

export const McoImageV3Container = {
  block: 0,
  compactBlock: 1,
  boundsBlock: 2,
  compactBoundsBlock: 3,
  regions: 4,
  compactRegionsStream: 5,
  solidBackground: 6,
  solidRects: 7,
} as const;
export const McoImageV3ContainerName = [
  'block', 'compactBlock', 'boundsBlock', 'compactBoundsBlock',
  'regions', 'compactRegionsStream', 'solidBackground', 'solidRects',
] as const;

export const McoImageV3BlockAlgorithm = {
  rawGlobal: 0,
  rawLocal: 1,
  compactRle: 2,
  compactSparse: 3,
  biColorMask: 4,
  rowRepeat: 5,
  lzPixels: 6,
  quadtree: 7,
  bitplanes: 8,
  adaptiveBitplanes: 9,
  directBitplanes: 10,
  compactRowDelta: 11,
  directRowDelta: 12,
  rowDelta: 13,
  varUintRle: 14,
  varUintSparse: 15,
} as const;
export const McoImageV3BlockAlgorithmName = [
  'rawGlobal', 'rawLocal', 'compactRle', 'compactSparse', 'biColorMask',
  'rowRepeat', 'lzPixels', 'quadtree', 'bitplanes', 'adaptiveBitplanes',
  'directBitplanes', 'compactRowDelta', 'directRowDelta', 'rowDelta',
  'varUintRle', 'varUintSparse',
] as const;

export const TRANSPARENT_FLAG = 0x80;
export const IMPLICIT_WHITE_BACKGROUND_FLAG = 0x40;
export const SCAN_SHIFT = 4;
export const SCAN_MASK = 0x30;
export const PROFILE_MASK = 0x0f;
export const DIMENSION_MODE_SQUARE64 = 0;
export const DIMENSION_MODE_SMALL32 = 1;
export const DIMENSION_MODE_MEDIUM64 = 2;
export const DIMENSION_MODE_EXTENDED = 3;
export const CONTAINER_CONTEXT_CONTAINER_SHIFT = 5;
export const CONTAINER_CONTEXT_MASK = 0x1f;
export const MIN_SIZE = 1;
export const MAX_SIZE = 256;
export const MAX_REGIONS = 32;
export const MIN_LZ_MATCH_LENGTH = 3;
export const HYBRID_COMMON_REGION_ALGORITHM_MARKER = 31;

export const LOCAL_PALETTE_DESCRIPTOR_BITS = 2;
export const LOCAL_PALETTE_SMALL_LENGTH_LIMIT = 64;
export const LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT = 128;
export const LOCAL_PALETTE_LARGE_LENGTH_LIMIT = 384;
export const LOCAL_PALETTE_DESCRIPTOR_BITMAP = 0;
export const LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA = 1;
export const LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS = 2;
export const LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS = 3;
export const LOCAL_PALETTE_BANK_DESCRIPTOR_BITMAPS = 0;
export const LOCAL_PALETTE_BANK_DESCRIPTOR_ORDERED_8X64 = 1;

export const ROW_DELTA_OP_BITS = 2;
export const ROW_DELTA_OP_RAW = 0;
export const ROW_DELTA_OP_REPEAT = 1;
export const ROW_DELTA_OP_INDEXED = 2;
export const ROW_DELTA_OP_EXTENDED = 3;
export const ROW_DELTA_EXTENDED_BITS = 2;
export const ROW_DELTA_EXTENDED_MASK = 0;
export const ROW_DELTA_EXTENDED_SEGMENTS = 1;
export const ROW_DELTA_EXTENDED_SAME_SCALAR_MASK = 2;
export const ROW_DELTA_EXTENDED_REPEAT_RUN = 3;

export const COMPACT_ROW_DELTA_OP_BITS = 3;
export const COMPACT_ROW_DELTA_OP_REPEAT = 0;
export const COMPACT_ROW_DELTA_OP_RAW = 1;
export const COMPACT_ROW_DELTA_OP_INDEXED = 2;
export const COMPACT_ROW_DELTA_OP_SAME_SCALAR = 3;
export const COMPACT_ROW_DELTA_OP_SEGMENTS = 4;
export const COMPACT_ROW_DELTA_OP_TRIMMED_MASK = 5;
export const COMPACT_ROW_DELTA_OP_REPEAT_RUN = 6;
export const COMPACT_ROW_DELTA_OP_PREDICTED = 7;
export const ROW_DELTA_PREDICTOR_SAME = 0;
export const ROW_DELTA_PREDICTOR_LEFT = 1;
export const ROW_DELTA_PREDICTOR_RIGHT = 2;
export const SUBTYPE_VERSION = 0x13;
export const TEXT_PREFIX = 'im3:';

export type PaletteProfileId = (typeof PaletteProfile)[keyof typeof PaletteProfile];
export type ScanModeId = (typeof ScanMode)[keyof typeof ScanMode];
export type McoImageV3ContainerId = (typeof McoImageV3Container)[keyof typeof McoImageV3Container];
export type McoImageV3BlockAlgorithmId =
  (typeof McoImageV3BlockAlgorithm)[keyof typeof McoImageV3BlockAlgorithm];
