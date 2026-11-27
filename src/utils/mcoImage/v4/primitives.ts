/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: coordinates, dimensions, colour references.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 85-86, 3274-3293, 3383-3486, 3518-3595; lib/helpers/mcoimg_palette.dart lines 14-24 (black index)
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
import { bitLength } from '../v3/bitReader.js';
import { PaletteProfile, PaletteProfileName } from '../v3/constants.js';
import type { PaletteProfileId } from '../v3/constants.js';
import { DYNAMIC_GLOBAL512_RGB, DynamicGlobalIndices, isDynamicProfile, paletteSize } from '../v3/palettes.js';
import type { V4BitReader } from './bitReader.js';
import {
  COORDINATE_OVERSCAN_MAX,
  DIMENSION_MODE_EXTENDED,
  DIMENSION_MODE_MEDIUM64,
  DIMENSION_MODE_SMALL32,
  DIMENSION_MODE_SQUARE64,
} from './constants.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import type { V4Point } from './model.js';

/** coordinateMarginForCanvasSize (codec 85-86). */
export function coordinateMargin(size: number): number {
  return Math.min(COORDINATE_OVERSCAN_MAX, Math.max(1, (size + 7) >> 3));
}

export function coordinateValueCount(size: number): number {
  return size + coordinateMargin(size) * 2;
}

export function coordinateBits(size: number): number {
  return Math.max(1, bitLength(coordinateValueCount(size) - 1));
}

export function localCoordinateBits(size: number): number {
  return Math.max(1, bitLength(size - 1));
}

export function isCoordinateInRange(value: number, size: number): boolean {
  const margin = coordinateMargin(size);
  return value >= -margin && value < size + margin;
}

export function scalarBits(width: number, height: number): number {
  return Math.max(1, bitLength(Math.max(width, height) - 1));
}

export function profilePaletteSize(profile: PaletteProfileId): number {
  return paletteSize(profile);
}

export function profileColorBits(profile: PaletteProfileId): number {
  return Math.max(1, bitLength(profilePaletteSize(profile) - 1));
}

/** Codec 3575-3589, payload form. */
export function colorFromProfileRef(profile: PaletteProfileId, ref: number): number {
  const size = profilePaletteSize(profile);
  if (ref < 0 || ref >= size) {
    throw new McoImageV4InvalidPayloadError(`Color reference ${ref} is outside ${PaletteProfileName[profile]}`);
  }
  return isDynamicProfile(profile) ? DynamicGlobalIndices[profile][ref] : ref;
}

export function zigZagDecode(value: number): number {
  return (value & 1) === 0 ? value >> 1 : -((value + 1) >> 1);
}

/** mcoimg_palette.dart 14-24: black's profile colour id in each fixed profile. */
const FIXED_BLACK_INDEX: Readonly<Record<number, number>> = {
  [PaletteProfile.mono]: 1,
  [PaletteProfile.master4]: 3,
  [PaletteProfile.master8]: 2,
  [PaletteProfile.grayscale8]: 7,
  [PaletteProfile.master16]: 2,
  [PaletteProfile.grayscale16]: 15,
  [PaletteProfile.master32]: 3,
  [PaletteProfile.grayscale32]: 31,
  [PaletteProfile.master64]: 7,
};

/**
 * Fixed profiles: the table above. Dynamic profiles: the first Global 512 index in the
 * profile whose colour is black (mcoimg_dynamic_palettes.dart blackGlobalIndexFor).
 */
export function blackIndexFor(profile: PaletteProfileId): number {
  if (isDynamicProfile(profile)) {
    for (const globalIndex of DynamicGlobalIndices[profile]) {
      if (DYNAMIC_GLOBAL512_RGB[globalIndex] === 0x000000) return globalIndex;
    }
    throw new McoImageV4InvalidPayloadError(`Dynamic palette ${PaletteProfileName[profile]} has no black color`);
  }
  const index = FIXED_BLACK_INDEX[profile];
  if (index === undefined) {
    throw new McoImageV4InvalidPayloadError(`Palette profile ${PaletteProfileName[profile]} is not fixed`);
  }
  return index;
}

/** Codec 3383-3428. */
export function readDimensions(reader: V4BitReader): { width: number; height: number } {
  const mode = reader.readBits(2);
  let width = 0;
  let height = 0;
  switch (mode) {
    case DIMENSION_MODE_SQUARE64:
      width = reader.readBits(6) + 1;
      height = width;
      break;
    case DIMENSION_MODE_SMALL32:
      width = reader.readBits(5) + 1;
      height = reader.readBits(5) + 1;
      if (width === height) {
        throw new McoImageV4InvalidPayloadError('Non-canonical v4 small square dimensions');
      }
      break;
    case DIMENSION_MODE_MEDIUM64:
      width = reader.readBits(6) + 1;
      height = reader.readBits(6) + 1;
      if (width === height || (width <= 32 && height <= 32)) {
        throw new McoImageV4InvalidPayloadError('Non-canonical v4 medium dimensions');
      }
      break;
    case DIMENSION_MODE_EXTENDED: {
      const generalRectangle = reader.readBit();
      if (!generalRectangle) {
        width = reader.readBits(8) + 1;
        height = width;
        if (width <= 64) {
          throw new McoImageV4InvalidPayloadError('Non-canonical v4 extended square dimensions');
        }
      } else {
        width = reader.readBits(8) + 1;
        height = reader.readBits(8) + 1;
        if (width === height || (width <= 64 && height <= 64)) {
          throw new McoImageV4InvalidPayloadError('Non-canonical v4 extended dimensions');
        }
      }
      break;
    }
  }
  return { width, height };
}

export function readCoordinate(reader: V4BitReader, bits: number, size: number): number {
  const value = reader.readBits(bits);
  if (value >= coordinateValueCount(size)) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 coordinate is out of range');
  }
  return value - coordinateMargin(size);
}

export function readLocalCoordinate(reader: V4BitReader, bits: number, size: number): number {
  const value = reader.readBits(bits);
  if (value >= size) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 coordinate is out of range');
  }
  return value;
}

export function readPoint(reader: V4BitReader, width: number, height: number, xBits: number, yBits: number): V4Point {
  const x = readCoordinate(reader, xBits, width);
  const y = readCoordinate(reader, yBits, height);
  return { x, y };
}

export function validatePointInPayload(point: V4Point, width: number, height: number): void {
  if (!isCoordinateInRange(point.x, width) || !isCoordinateInRange(point.y, height)) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 coordinate is out of range');
  }
}

export function validateLocalPointInPayload(point: V4Point, width: number, height: number): void {
  if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 coordinate is out of range');
  }
}

/**
 * Codec 3274-3293 with the integer test the reference prescribes
 * (mcoimg_v4_reference.md, ELLIPSE_DEPTH): the third point is an integer point exactly when
 * L = sqrt(dx^2 + dy^2) is an integer and both numerators divide by 2L.
 */
export function ellipseThirdFromDepth(first: V4Point, second: V4Point, depth: number): V4Point | null {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return null;
  const length = Math.round(Math.sqrt(lengthSquared));
  if (length * length !== lengthSquared) return null;
  const numeratorX = (first.x + second.x) * length - 2 * dy * depth;
  const numeratorY = (first.y + second.y) * length + 2 * dx * depth;
  const divisor = 2 * length;
  if (numeratorX % divisor !== 0 || numeratorY % divisor !== 0) return null;
  return { x: numeratorX / divisor + 0, y: numeratorY / divisor + 0 };
}

/** Canvas size and the bit widths derived from it, shared by every figure reader. */
export interface V4Dims {
  readonly width: number;
  readonly height: number;
  readonly xBits: number;
  readonly yBits: number;
  readonly scalarBits: number;
}
