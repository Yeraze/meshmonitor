/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 583-662 (dimensions and colour refs)
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
import { DIMENSION_MODE_EXTENDED, DIMENSION_MODE_MEDIUM64, DIMENSION_MODE_SMALL32, DIMENSION_MODE_SQUARE64 } from './constants.js';
import type { PaletteProfileId } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { colorFromProfileRef, globalBits, whiteIndexFor } from './palettes.js';
import { BitReader } from './bitReader.js';
import { validateDimensions } from './validate.js';

export function readDimensions(reader: BitReader) {
  const mode = reader.readBits(2);
  let width;
  let height;
  switch (mode) {
    case DIMENSION_MODE_SQUARE64:
      width = reader.readBits(6) + 1;
      height = width;
      break;
    case DIMENSION_MODE_SMALL32:
      width = reader.readBits(5) + 1;
      height = reader.readBits(5) + 1;
      if (width === height) {
        throw new McoImageV3InvalidPayloadError('Non-canonical small square dimensions');
      }
      break;
    case DIMENSION_MODE_MEDIUM64:
      width = reader.readBits(6) + 1;
      height = reader.readBits(6) + 1;
      if (width === height || (width <= 32 && height <= 32)) {
        throw new McoImageV3InvalidPayloadError('Non-canonical medium dimensions');
      }
      break;
    case DIMENSION_MODE_EXTENDED: {
      const generalRectangle = reader.readBits(1) !== 0;
      if (!generalRectangle) {
        width = reader.readBits(8) + 1;
        height = width;
        if (width <= 64) {
          throw new McoImageV3InvalidPayloadError('Non-canonical extended square dimensions');
        }
      } else {
        width = reader.readBits(8) + 1;
        height = reader.readBits(8) + 1;
        if (width === height || (width <= 64 && height <= 64)) {
          throw new McoImageV3InvalidPayloadError('Non-canonical extended dimensions');
        }
      }
      break;
    }
    default:
      throw new McoImageV3InvalidPayloadError('Unknown dimension mode');
  }
  validateDimensions(width, height);
  return { width, height };
}

export function readColorRef(reader: BitReader, profile: PaletteProfileId) {
  return colorFromProfileRef(profile, reader.readBits(globalBits(profile)));
}

export function readBackgroundRef(reader: BitReader, profile: PaletteProfileId, implicitWhiteBackground: boolean) {
  return implicitWhiteBackground ? whiteIndexFor(profile) : readColorRef(reader, profile);
}

export function readContextualColorRef(reader: BitReader, profile: PaletteProfileId, context: number) {
  const totalBits = globalBits(profile);
  const lowBits = Math.min(totalBits, 5);
  const lowMask = (2 ** lowBits) - 1;
  if ((context & ~lowMask) !== 0) {
    throw new McoImageV3InvalidPayloadError('Solid background color context is out of range');
  }
  const remainingBits = totalBits - lowBits;
  const colorRef = remainingBits > 0
    ? context | (reader.readBits(remainingBits) << lowBits)
    : context;
  return colorFromProfileRef(profile, colorRef);
}

export function readSolidBackgroundColor(reader: BitReader, profile: PaletteProfileId, context: number, implicitWhiteBackground: boolean) {
  if (implicitWhiteBackground) {
    if (context !== 0) {
      throw new McoImageV3InvalidPayloadError(
        'Implicit white solid background must use zero context',
      );
    }
    return whiteIndexFor(profile);
  }
  return readContextualColorRef(reader, profile, context);
}
