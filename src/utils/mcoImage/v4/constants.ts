/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: constants and decode limits.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 12-74 and 3383-3428
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file; only types were added. Safety limits (see budget.ts) are a MeshMonitor
 * addition.
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
// Opcodes and widths of codec lines 12-74, 3383-3428.

export const SUBTYPE_VERSION_V4 = 0x14;
export const TEXT_PREFIX_V4 = 'im4:';

export const OP_END = 0;
export const OP_SET_FILL = 1;
export const OP_SET_STROKE = 2;
export const OP_SET_STROKE_WIDTH = 3;
export const OP_DOT = 4;
export const OP_LINE = 5;
export const OP_RECT = 6;
export const OP_ELLIPSE = 7;
export const OP_RECT_AXIS_ALIGNED = 8;
export const OP_PATH_ABSOLUTE = 9;
export const OP_PATH_DELTA = 10;
export const OP_WAVE = 11;
export const OP_REPEAT_LAST = 12;
export const OP_ELLIPSE_AXIS_ALIGNED = 13;
export const OP_REPEAT_SHORT = 14;
export const OP_EXTENDED = 15;
export const OP_BITS = 4;
export const MODE_BITS = 2;

export const DELTA_WIDTHS: readonly number[] = [3, 4, 5, 6];

export const EXT_LINE_DELTA = 0;
export const EXT_LINE_AXIS_DELTA = 1;
export const EXT_AREA_DELTA = 2;
export const EXT_WAVE_DELTA = 3;
export const EXT_PATH_ORTHOGONAL = 4;
export const EXT_PATH_BOUNDS = 5;
export const EXT_PATH_BOUNDS_DELTA = 6;
export const EXT_LINE_AXIS_ABSOLUTE = 7;
export const EXT_ELLIPSE_DEPTH = 8;
export const EXT_REPEAT_BACK = 9;
export const EXT_DOT_RUN = 10;
export const EXT_SET_STYLE = 11;
export const EXT_REPEAT_COLOR_RUN = 12;
export const EXT_GROUP = 13;
export const EXT_RASTER_LAYER = 14;
/** Sub-opcode 15 is a second escape rather than a command. */
export const EXT_ESCAPE = 15;
export const EXT_BITS = 4;
export const EXT2_BITS = 4;
export const EXT2_TEXT = 0;
export const TEXT_MASK_BITS = 3;
export const TEXT_ALIGN_BITS = 2;

export const DIMENSION_MODE_SQUARE64 = 0;
export const DIMENSION_MODE_SMALL32 = 1;
export const DIMENSION_MODE_MEDIUM64 = 2;
export const DIMENSION_MODE_EXTENDED = 3;
export const COORDINATE_OVERSCAN_MAX = 16;

export const Mode = { vector: 0, mixed: 1, raster: 2, reserved: 3 } as const;

/**
 * MeshMonitor decode limits. A hostile payload can expand exponentially (a repeat copies a
 * whole group, a group can hold a repeat of itself), so every limit is checked BEFORE the
 * copies are built. Client-side safety limits, not mesh policy.
 */
export interface McoV4Limits {
  /** Every materialised figure, groups and group children included. */
  readonly maxFigures: number;
  readonly maxGroupDepth: number;
  /** Path points plus dots, copies included. */
  readonly maxPathPoints: number;
  readonly maxRasterLayers: number;
  readonly maxRasterPixels: number;
  /** All text figures, copies included. */
  readonly maxTextCodePoints: number;
}

export const MCO_V4_DEFAULT_LIMITS: McoV4Limits = Object.freeze({
  maxFigures: 4096,
  maxGroupDepth: 16,
  maxPathPoints: 16384,
  maxRasterLayers: 16,
  maxRasterPixels: 262144,
  maxTextCodePoints: 4096,
});
