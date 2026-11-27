/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 866-1765 (geometry, scan order, quadtree, bitplanes, row-delta, block bodies)
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
import { COMPACT_ROW_DELTA_OP_BITS, COMPACT_ROW_DELTA_OP_INDEXED, COMPACT_ROW_DELTA_OP_PREDICTED, COMPACT_ROW_DELTA_OP_RAW, COMPACT_ROW_DELTA_OP_REPEAT, COMPACT_ROW_DELTA_OP_REPEAT_RUN, COMPACT_ROW_DELTA_OP_SAME_SCALAR, COMPACT_ROW_DELTA_OP_SEGMENTS, COMPACT_ROW_DELTA_OP_TRIMMED_MASK, MIN_LZ_MATCH_LENGTH, McoImageV3BlockAlgorithm, ROW_DELTA_EXTENDED_BITS, ROW_DELTA_EXTENDED_MASK, ROW_DELTA_EXTENDED_REPEAT_RUN, ROW_DELTA_EXTENDED_SAME_SCALAR_MASK, ROW_DELTA_EXTENDED_SEGMENTS, ROW_DELTA_OP_BITS, ROW_DELTA_OP_EXTENDED, ROW_DELTA_OP_INDEXED, ROW_DELTA_OP_RAW, ROW_DELTA_OP_REPEAT, ROW_DELTA_PREDICTOR_LEFT, ROW_DELTA_PREDICTOR_RIGHT, ROW_DELTA_PREDICTOR_SAME, ScanMode } from './constants.js';
import type { McoImageV3BlockAlgorithmId, PaletteProfileId, ScanModeId } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { dynamicProfilePalette, globalBits, isDynamicProfile, isGrayscaleProfile, paletteSize } from './palettes.js';
import { BitReader, bitLength } from './bitReader.js';
import { geometryBits, localBits } from './validate.js';
import { readBackgroundRef, readColorRef } from './readers.js';
import { readLocalPalette } from './localPalette.js';

export interface RegionGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function readRegionGeometry(reader: BitReader, imageWidth: number, imageHeight: number, compactGeometry: boolean) {
  const xBits = compactGeometry ? geometryBits(imageWidth) : 8;
  const yBits = compactGeometry ? geometryBits(imageHeight) : 8;
  const x = reader.readBits(xBits);
  const y = reader.readBits(yBits);
  if (x >= imageWidth || y >= imageHeight) {
    throw new McoImageV3InvalidPayloadError('Invalid v3 region origin');
  }
  const widthBits = compactGeometry ? geometryBits(imageWidth - x) : xBits;
  const heightBits = compactGeometry ? geometryBits(imageHeight - y) : yBits;
  const width = reader.readBits(widthBits) + 1;
  const height = reader.readBits(heightBits) + 1;
  if (x + width > imageWidth || y + height > imageHeight) {
    throw new McoImageV3InvalidPayloadError('Invalid v3 region');
  }
  return { x, y, width, height };
}

export function readSignedCompactInt(reader: BitReader) {
  const encoded = reader.readCompactUint();
  return (encoded & 1) === 0 ? Math.floor(encoded / 2) : -Math.floor((encoded + 1) / 2);
}

export function readDeltaRegionGeometry(reader: BitReader, previous: RegionGeometry, imageWidth: number, imageHeight: number) {
  const bounds = {
    x: previous.x + readSignedCompactInt(reader),
    y: previous.y + readSignedCompactInt(reader),
    width: previous.width + readSignedCompactInt(reader),
    height: previous.height + readSignedCompactInt(reader),
  };
  if (bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 ||
      bounds.x + bounds.width > imageWidth || bounds.y + bounds.height > imageHeight) {
    throw new McoImageV3InvalidPayloadError('Invalid v3 delta region');
  }
  return bounds;
}

export function rowLengthForScan(scan: ScanModeId, width: number, height: number) {
  return scan === ScanMode.h || scan === ScanMode.s ? width : height;
}

export function fromScanOrder(linear: readonly number[], width: number, height: number, scan: ScanModeId) {
  if (linear.length !== width * height) {
    throw new McoImageV3InvalidPayloadError('Decoded pixel count does not match dimensions');
  }
  if (scan === ScanMode.h) return Array.from(linear);
  const result = new Array<number>(width * height).fill(0);
  let index = 0;
  if (scan === ScanMode.v) {
    for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) result[y * width + x] = linear[index++];
  } else if (scan === ScanMode.s) {
    for (let y = 0; y < height; y++) {
      if ((y & 1) === 0) {
        for (let x = 0; x < width; x++) result[y * width + x] = linear[index++];
      } else {
        for (let x = width - 1; x >= 0; x--) result[y * width + x] = linear[index++];
      }
    }
  } else if (scan === ScanMode.sv) {
    for (let x = 0; x < width; x++) {
      if ((x & 1) === 0) {
        for (let y = 0; y < height; y++) result[y * width + x] = linear[index++];
      } else {
        for (let y = height - 1; y >= 0; y--) result[y * width + x] = linear[index++];
      }
    }
  } else {
    throw new McoImageV3InvalidPayloadError(`Unknown scan mode ${scan}`);
  }
  return result;
}

export function readQuadtreeNode(reader: BitReader, pixels: number[], stride: number, x: number, y: number, width: number, height: number, palette: readonly number[], bits: number) {
  const isSolid = reader.readBits(1) !== 0;
  if (isSolid) {
    const colorIndex = reader.readBits(bits);
    if (colorIndex >= palette.length) {
      throw new McoImageV3InvalidPayloadError('Quadtree color index out of range');
    }
    for (let dy = 0; dy < height; dy++) {
      const rowStart = (y + dy) * stride + x;
      for (let dx = 0; dx < width; dx++) pixels[rowStart + dx] = palette[colorIndex];
    }
    return;
  }
  if (width === 1 && height === 1) {
    throw new McoImageV3InvalidPayloadError('Quadtree splits a single pixel');
  }
  if (width === 1) {
    const topHeight = Math.floor(height / 2);
    readQuadtreeNode(reader, pixels, stride, x, y, width, topHeight, palette, bits);
    readQuadtreeNode(reader, pixels, stride, x, y + topHeight, width, height - topHeight, palette, bits);
    return;
  }
  if (height === 1) {
    const leftWidth = Math.floor(width / 2);
    readQuadtreeNode(reader, pixels, stride, x, y, leftWidth, height, palette, bits);
    readQuadtreeNode(reader, pixels, stride, x + leftWidth, y, width - leftWidth, height, palette, bits);
    return;
  }
  const leftWidth = Math.floor(width / 2);
  const topHeight = Math.floor(height / 2);
  readQuadtreeNode(reader, pixels, stride, x, y, leftWidth, topHeight, palette, bits);
  readQuadtreeNode(reader, pixels, stride, x + leftWidth, y, width - leftWidth, topHeight, palette, bits);
  readQuadtreeNode(reader, pixels, stride, x, y + topHeight, leftWidth, height - topHeight, palette, bits);
  readQuadtreeNode(reader, pixels, stride, x + leftWidth, y + topHeight, width - leftWidth, height - topHeight, palette, bits);
}

export function readShortBitplaneRunLength(reader: BitReader, remainingLength: number) {
  if (remainingLength <= 0) {
    throw new McoImageV3InvalidPayloadError('Invalid remaining bitplane run length');
  }
  if (reader.readBits(1) === 0) return 1;
  if (remainingLength < 2) throw new McoImageV3InvalidPayloadError('Bitplane run exceeds remaining pixels');
  if (reader.readBits(1) === 0) return 2;
  if (remainingLength < 3) throw new McoImageV3InvalidPayloadError('Bitplane run exceeds remaining pixels');
  if (reader.readBits(1) === 0) return 3;
  if (remainingLength < 4) throw new McoImageV3InvalidPayloadError('Bitplane run exceeds remaining pixels');
  return reader.readRangeCompactUint(remainingLength - 4) + 4;
}

export function readAdaptiveBitplaneRuns(reader: BitReader, pixels: number[], bit: number, pixelCount: number, shortLengths: boolean) {
  let value = reader.readBits(1);
  let position = 0;
  while (position < pixelCount) {
    const length = shortLengths
      ? readShortBitplaneRunLength(reader, pixelCount - position)
      : reader.readRangeCompactUint(pixelCount - position - 1) + 1;
    if (length <= 0 || position + length > pixelCount) {
      throw new McoImageV3InvalidPayloadError('Adaptive bitplane RLE exceeds pixel count');
    }
    if (value !== 0) for (let i = 0; i < length; i++) pixels[position + i] |= 1 << bit;
    position += length;
    value ^= 1;
  }
}

export function readSparseBitplane(reader: BitReader, pixels: number[], bit: number, pixelCount: number, minorityBit: number) {
  const count = reader.readRangeCompactUint(pixelCount - 1) + 1;
  if (count > pixelCount) {
    throw new McoImageV3InvalidPayloadError('Sparse bitplane count exceeds pixel count');
  }
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const remainingPositions = count - i - 1;
    const maxGap = pixelCount - previous - remainingPositions - 2;
    const gap = reader.readRangeCompactUint(maxGap);
    const position = previous + gap + 1;
    if (position <= previous || position >= pixelCount) {
      throw new McoImageV3InvalidPayloadError('Sparse bitplane position out of range');
    }
    if (minorityBit === 0) pixels[position] &= ~(1 << bit);
    else pixels[position] |= 1 << bit;
    previous = position;
  }
}

export function decodeAdaptiveBitplanesBody(reader: BitReader, pixelCount: number, palette: readonly number[]) {
  const bits = localBits(palette.length);
  const localPixels = new Array<number>(pixelCount).fill(0);
  for (let bit = 0; bit < bits; bit++) {
    const first = reader.readBits(1);
    if (first === 0) {
      for (let i = 0; i < pixelCount; i++) localPixels[i] |= reader.readBits(1) << bit;
      continue;
    }
    const second = reader.readBits(1);
    if (second === 0) {
      readAdaptiveBitplaneRuns(reader, localPixels, bit, pixelCount, false);
      continue;
    }
    const third = reader.readBits(1);
    if (third === 0) {
      readAdaptiveBitplaneRuns(reader, localPixels, bit, pixelCount, true);
      continue;
    }
    switch (reader.readBits(2)) {
      case 0:
        break;
      case 1:
        for (let i = 0; i < pixelCount; i++) localPixels[i] |= 1 << bit;
        break;
      case 2:
        readSparseBitplane(reader, localPixels, bit, pixelCount, 1);
        break;
      case 3:
        for (let i = 0; i < pixelCount; i++) localPixels[i] |= 1 << bit;
        readSparseBitplane(reader, localPixels, bit, pixelCount, 0);
        break;
    }
  }
  return localPixels.map((index) => {
    if (index >= palette.length) {
      throw new McoImageV3InvalidPayloadError('Adaptive bitplane color index out of range');
    }
    return palette[index];
  });
}

export function readCompactRowDeltaPredictor(reader: BitReader) {
  if (reader.readBits(1) === 0) return ROW_DELTA_PREDICTOR_SAME;
  return reader.readBits(1) === 0 ? ROW_DELTA_PREDICTOR_LEFT : ROW_DELTA_PREDICTOR_RIGHT;
}

export function compactRowDeltaPredictedValue(values: number[], rowLength: number, row: number, x: number, predictor: number, useVirtualBaseRow: boolean) {
  if (row === 0 && useVirtualBaseRow) return 0;
  const previousStart = (row - 1) * rowLength;
  switch (predictor) {
    case ROW_DELTA_PREDICTOR_LEFT:
      return values[previousStart + (x === 0 ? rowLength - 1 : x - 1)];
    case ROW_DELTA_PREDICTOR_RIGHT:
      return values[previousStart + (x + 1 === rowLength ? 0 : x + 1)];
    default:
      return values[previousStart + x];
  }
}

export function copyCompactRowDeltaPredictedRow(values: number[], rowStart: number, rowLength: number, row: number, predictor: number, useVirtualBaseRow: boolean) {
  for (let x = 0; x < rowLength; x++) {
    values[rowStart + x] = compactRowDeltaPredictedValue(
      values, rowLength, row, x, predictor, useVirtualBaseRow,
    );
  }
}

export function readRowDeltaValue(reader: BitReader, valueBits: number, maxValue: number) {
  const value = reader.readBits(valueBits);
  if (value > maxValue) throw new McoImageV3InvalidPayloadError('Row-delta value out of range');
  return value;
}

export function readRowDeltaPredictor(reader: BitReader, row: number, useVirtualBaseRow: boolean, allowShiftPredictors: boolean) {
  if (!allowShiftPredictors) return ROW_DELTA_PREDICTOR_SAME;
  const predictor = readCompactRowDeltaPredictor(reader);
  if (row === 0 && useVirtualBaseRow && predictor !== ROW_DELTA_PREDICTOR_SAME) {
    throw new McoImageV3InvalidPayloadError('Shifted row-delta predictor cannot use virtual row');
  }
  return predictor;
}

export function readRowDeltaMask(reader: BitReader, result: number[], rowStart: number, rowLength: number, valueBits: number, maxValue: number, sameScalar: boolean) {
  const positions = [];
  for (let x = 0; x < rowLength; x++) if (reader.readBits(1) !== 0) positions.push(x);
  if (positions.length === 0) throw new McoImageV3InvalidPayloadError('Empty row-delta mask');
  if (sameScalar) {
    const value = readRowDeltaValue(reader, valueBits, maxValue);
    for (const x of positions) result[rowStart + x] = value;
  } else {
    for (const x of positions) result[rowStart + x] = readRowDeltaValue(reader, valueBits, maxValue);
  }
}

export function readRowDeltaSegments(reader: BitReader, result: number[], rowStart: number, rowLength: number, valueBits: number, maxValue: number) {
  const positionBits = bitLength(rowLength - 1);
  const segmentCount = reader.readBits(bitLength(rowLength - 1)) + 1;
  let previousEnd = -1;
  for (let i = 0; i < segmentCount; i++) {
    const start = reader.readBits(positionBits);
    const length = reader.readBits(positionBits) + 1;
    if (start <= previousEnd || start + length > rowLength) {
      throw new McoImageV3InvalidPayloadError('Invalid row-delta segment');
    }
    for (let x = start; x < start + length; x++) {
      result[rowStart + x] = readRowDeltaValue(reader, valueBits, maxValue);
    }
    previousEnd = start + length - 1;
  }
}

export function readRowDeltaBody(reader: BitReader, count: number, rowLength: number, valueBits: number, maxValue: number) {
  if (rowLength <= 0 || count % rowLength !== 0) {
    throw new McoImageV3InvalidPayloadError('Invalid row-delta geometry');
  }
  if (count === 0) return [];
  const useVirtualBaseRow = reader.readBits(1) !== 0;
  const allowShiftPredictors = reader.readBits(1) !== 0;
  const result = new Array<number>(count).fill(0);
  if (!useVirtualBaseRow) {
    for (let x = 0; x < rowLength; x++) result[x] = readRowDeltaValue(reader, valueBits, maxValue);
  }
  const rowCount = count / rowLength;
  let row = useVirtualBaseRow ? 0 : 1;
  while (row < rowCount) {
    const rowStart = row * rowLength;
    const op = reader.readBits(ROW_DELTA_OP_BITS);
    if (op === ROW_DELTA_OP_RAW) {
      for (let x = 0; x < rowLength; x++) result[rowStart + x] = readRowDeltaValue(reader, valueBits, maxValue);
      row++;
      continue;
    }
    if (op === ROW_DELTA_OP_REPEAT) {
      copyCompactRowDeltaPredictedRow(result, rowStart, rowLength, row, ROW_DELTA_PREDICTOR_SAME, useVirtualBaseRow);
      row++;
      continue;
    }
    if (op === ROW_DELTA_OP_INDEXED) {
      const predictor = readRowDeltaPredictor(reader, row, useVirtualBaseRow, allowShiftPredictors);
      copyCompactRowDeltaPredictedRow(result, rowStart, rowLength, row, predictor, useVirtualBaseRow);
      const changeCount = reader.readBits(bitLength(rowLength));
      if (changeCount > rowLength) {
        throw new McoImageV3InvalidPayloadError('Row-delta change count exceeds row length');
      }
      const positionBits = bitLength(rowLength - 1);
      let previousX = -1;
      for (let i = 0; i < changeCount; i++) {
        const x = reader.readBits(positionBits);
        if (x >= rowLength || x <= previousX) {
          throw new McoImageV3InvalidPayloadError('Invalid row-delta change position');
        }
        result[rowStart + x] = readRowDeltaValue(reader, valueBits, maxValue);
        previousX = x;
      }
      row++;
      continue;
    }
    if (op !== ROW_DELTA_OP_EXTENDED) {
      throw new McoImageV3InvalidPayloadError('Unknown row-delta row op');
    }
    const extendedOp = reader.readBits(ROW_DELTA_EXTENDED_BITS);
    if (extendedOp === ROW_DELTA_EXTENDED_REPEAT_RUN) {
      if (row + 2 > rowCount) throw new McoImageV3InvalidPayloadError('Invalid row-delta repeat run');
      const repeatCount = reader.readRangeCompactUint(rowCount - row - 2) + 2;
      for (let repeat = 0; repeat < repeatCount; repeat++) {
        const repeatRow = row + repeat;
        copyCompactRowDeltaPredictedRow(
          result, repeatRow * rowLength, rowLength, repeatRow,
          ROW_DELTA_PREDICTOR_SAME, useVirtualBaseRow,
        );
      }
      row += repeatCount;
      continue;
    }
    const predictor = readRowDeltaPredictor(reader, row, useVirtualBaseRow, allowShiftPredictors);
    copyCompactRowDeltaPredictedRow(result, rowStart, rowLength, row, predictor, useVirtualBaseRow);
    switch (extendedOp) {
      case ROW_DELTA_EXTENDED_MASK:
        readRowDeltaMask(reader, result, rowStart, rowLength, valueBits, maxValue, false);
        break;
      case ROW_DELTA_EXTENDED_SEGMENTS:
        readRowDeltaSegments(reader, result, rowStart, rowLength, valueBits, maxValue);
        break;
      case ROW_DELTA_EXTENDED_SAME_SCALAR_MASK:
        readRowDeltaMask(reader, result, rowStart, rowLength, valueBits, maxValue, true);
        break;
      default:
        throw new McoImageV3InvalidPayloadError('Unknown row-delta extended op');
    }
    row++;
  }
  return result;
}

export function grayscaleDeltaFromCode(code: number) {
  if (code <= 0) throw new McoImageV3InvalidPayloadError('Invalid grayscale delta');
  return (code & 1) !== 0 ? Math.floor((code + 1) / 2) : -Math.floor(code / 2);
}

export function readCompactRowDeltaValue(
  reader: BitReader,
  values: number[],
  rowLength: number,
  row: number,
  x: number,
  valueBits: number,
  predictor: number,
  useVirtualBaseRow: boolean,
  useResidual: boolean,
  maxValue: number,
) {
  const value = useResidual
    ? compactRowDeltaPredictedValue(values, rowLength, row, x, predictor, useVirtualBaseRow) +
      grayscaleDeltaFromCode(reader.readCompactUint() + 1)
    : reader.readBits(valueBits);
  if (value < 0 || value > maxValue) {
    throw new McoImageV3InvalidPayloadError('Compact row-delta value out of range');
  }
  return value;
}

export function readCompactChangePositions(reader: BitReader, count: number, rowLength: number) {
  const positions = [];
  let previousX = -1;
  for (let i = 0; i < count; i++) {
    const remainingPositions = count - i - 1;
    const maxGap = rowLength - previousX - remainingPositions - 2;
    const x = previousX + 1 + reader.readRangeCompactUint(maxGap);
    if (x >= rowLength) {
      throw new McoImageV3InvalidPayloadError('Compact row-delta position out of range');
    }
    positions.push(x);
    previousX = x;
  }
  return positions;
}

export function readCompactRowDeltaBody(reader: BitReader, count: number, rowLength: number, valueBits: number, directGrayscale: boolean, maxValue: number) {
  if (rowLength <= 0 || count % rowLength !== 0) {
    throw new McoImageV3InvalidPayloadError('Invalid compact row-delta geometry');
  }
  const useVirtualBaseRow = reader.readBits(1) !== 0;
  const result = new Array<number>(count).fill(0);
  if (!useVirtualBaseRow) {
    for (let x = 0; x < rowLength; x++) {
      const value = reader.readBits(valueBits);
      if (value > maxValue) {
        throw new McoImageV3InvalidPayloadError('Compact row-delta first row value out of range');
      }
      result[x] = value;
    }
  }
  const rowCount = count / rowLength;
  let row = useVirtualBaseRow ? 0 : 1;
  while (row < rowCount) {
    const rowStart = row * rowLength;
    const op = reader.readBits(COMPACT_ROW_DELTA_OP_BITS);
    if (op === COMPACT_ROW_DELTA_OP_REPEAT || op === COMPACT_ROW_DELTA_OP_REPEAT_RUN) {
      const repeatCount = op === COMPACT_ROW_DELTA_OP_REPEAT
        ? 1
        : reader.readRangeCompactUint(rowCount - row - 2) + 2;
      if (row + repeatCount > rowCount) {
        throw new McoImageV3InvalidPayloadError('Compact row-delta repeat exceeds row count');
      }
      for (let repeat = 0; repeat < repeatCount; repeat++) {
        const repeatRow = row + repeat;
        copyCompactRowDeltaPredictedRow(
          result, repeatRow * rowLength, rowLength, repeatRow,
          ROW_DELTA_PREDICTOR_SAME, useVirtualBaseRow,
        );
      }
      row += repeatCount;
      continue;
    }
    if (op === COMPACT_ROW_DELTA_OP_RAW) {
      for (let x = 0; x < rowLength; x++) {
        const value = reader.readBits(valueBits);
        if (value > maxValue) {
          throw new McoImageV3InvalidPayloadError('Compact row-delta raw value out of range');
        }
        result[rowStart + x] = value;
      }
      row++;
      continue;
    }
    const predictor = readCompactRowDeltaPredictor(reader);
    if (row === 0 && useVirtualBaseRow && predictor !== ROW_DELTA_PREDICTOR_SAME) {
      throw new McoImageV3InvalidPayloadError('Shifted compact predictor cannot use virtual row');
    }
    copyCompactRowDeltaPredictedRow(result, rowStart, rowLength, row, predictor, useVirtualBaseRow);
    if (op === COMPACT_ROW_DELTA_OP_PREDICTED) {
      row++;
      continue;
    }
    const useResidual = directGrayscale && reader.readBits(1) !== 0;
    if (op === COMPACT_ROW_DELTA_OP_INDEXED || op === COMPACT_ROW_DELTA_OP_SAME_SCALAR) {
      const changeCount = reader.readRangeCompactUint(rowLength - 1) + 1;
      if (changeCount > rowLength) {
        throw new McoImageV3InvalidPayloadError('Compact row-delta change count exceeds row length');
      }
      const positions = readCompactChangePositions(reader, changeCount, rowLength);
      if (op === COMPACT_ROW_DELTA_OP_SAME_SCALAR) {
        const value = readCompactRowDeltaValue(
          reader, result, rowLength, row, positions[0], valueBits, predictor,
          useVirtualBaseRow, useResidual, maxValue,
        );
        for (const x of positions) result[rowStart + x] = value;
      } else {
        for (const x of positions) {
          result[rowStart + x] = readCompactRowDeltaValue(
            reader, result, rowLength, row, x, valueBits, predictor,
            useVirtualBaseRow, useResidual, maxValue,
          );
        }
      }
      row++;
      continue;
    }
    if (op === COMPACT_ROW_DELTA_OP_SEGMENTS || op === COMPACT_ROW_DELTA_OP_TRIMMED_MASK) {
      const positions = [];
      if (op === COMPACT_ROW_DELTA_OP_SEGMENTS) {
        const segmentCount = reader.readRangeCompactUint(rowLength - 1) + 1;
        if (segmentCount > rowLength) {
          throw new McoImageV3InvalidPayloadError('Compact row-delta segment count exceeds row length');
        }
        let previousEnd = 0;
        for (let i = 0; i < segmentCount; i++) {
          const remainingSegments = segmentCount - i - 1;
          const maxGap = rowLength - previousEnd - remainingSegments - 1;
          const gap = reader.readRangeCompactUint(maxGap);
          const start = previousEnd + gap;
          const maxLength = rowLength - start - remainingSegments;
          const length = reader.readRangeCompactUint(maxLength - 1) + 1;
          if (start < previousEnd || start + length > rowLength) {
            throw new McoImageV3InvalidPayloadError('Invalid compact row-delta segment');
          }
          for (let x = start; x < start + length; x++) positions.push(x);
          previousEnd = start + length;
        }
      } else {
        const start = reader.readRangeCompactUint(rowLength - 1);
        const span = reader.readRangeCompactUint(rowLength - start - 1) + 1;
        if (start + span > rowLength) {
          throw new McoImageV3InvalidPayloadError('Invalid compact row-delta mask bounds');
        }
        for (let offset = 0; offset < span; offset++) if (reader.readBits(1) !== 0) positions.push(start + offset);
        if (positions.length === 0) {
          throw new McoImageV3InvalidPayloadError('Empty compact row-delta mask');
        }
      }
      for (const x of positions) {
        result[rowStart + x] = readCompactRowDeltaValue(
          reader, result, rowLength, row, x, valueBits, predictor,
          useVirtualBaseRow, useResidual, maxValue,
        );
      }
      row++;
      continue;
    }
    throw new McoImageV3InvalidPayloadError('Unsupported compact row-delta op');
  }
  return result;
}

export function readRowRepeat(reader: BitReader, count: number, rowLength: number, bits: number) {
  if (rowLength <= 0 || count % rowLength !== 0) {
    throw new McoImageV3InvalidPayloadError('Invalid row-repeat geometry');
  }
  const result = new Array<number>(count).fill(0);
  for (let x = 0; x < rowLength; x++) result[x] = reader.readBits(bits);
  const rows = count / rowLength;
  for (let row = 1; row < rows; row++) {
    const rowStart = row * rowLength;
    const previousStart = rowStart - rowLength;
    if (reader.readBits(1) !== 0) {
      for (let x = 0; x < rowLength; x++) result[rowStart + x] = result[previousStart + x];
    } else {
      for (let x = 0; x < rowLength; x++) result[rowStart + x] = reader.readBits(bits);
    }
  }
  return result;
}

export function decodeBitplanesBody(reader: BitReader, count: number, palette: readonly number[]) {
  const bits = localBits(palette.length);
  const localPixels = new Array<number>(count).fill(0);
  for (let bit = 0; bit < bits; bit++) {
    const isRle = reader.readBits(1) !== 0;
    if (!isRle) {
      for (let i = 0; i < count; i++) localPixels[i] |= reader.readBits(1) << bit;
      continue;
    }
    let value = reader.readBits(1);
    let position = 0;
    while (position < count) {
      const length = reader.readRangeCompactUint(count - position - 1) + 1;
      if (position + length > count) {
        throw new McoImageV3InvalidPayloadError('Bitplane RLE exceeds pixel count');
      }
      if (value !== 0) for (let i = 0; i < length; i++) localPixels[position + i] |= 1 << bit;
      position += length;
      value ^= 1;
    }
  }
  return localPixels.map((index) => {
    if (index >= palette.length) {
      throw new McoImageV3InvalidPayloadError('Bitplane color index out of range');
    }
    return palette[index];
  });
}

export function mapLocalPixels(localPixels: readonly number[], palette: readonly number[], label: string = 'Shared palette color index out of range') {
  return localPixels.map((index) => {
    if (index >= palette.length) throw new McoImageV3InvalidPayloadError(label);
    return palette[index];
  });
}

export function decodeBlockBody(
  reader: BitReader,
  width: number,
  height: number,
  profile: PaletteProfileId,
  algorithm: McoImageV3BlockAlgorithmId,
  scan: ScanModeId,
  implicitWhiteBackground: boolean,
  inheritedBackgroundColor: number | null = null,
) {
  const count = width * height;
  switch (algorithm) {
    case McoImageV3BlockAlgorithm.rawGlobal: {
      const result: number[] = [];
      for (let i = 0; i < count; i++) result.push(readColorRef(reader, profile));
      return result;
    }
    case McoImageV3BlockAlgorithm.rawLocal: {
      const palette = readLocalPalette(reader, profile);
      const bits = localBits(palette.length);
      const result: number[] = [];
      for (let i = 0; i < count; i++) {
        const index = reader.readBits(bits);
        if (index >= palette.length) throw new McoImageV3InvalidPayloadError('Local color index out of range');
        result.push(palette[index]);
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.varUintRle:
    case McoImageV3BlockAlgorithm.compactRle: {
      const palette = readLocalPalette(reader, profile);
      const bits = localBits(palette.length);
      const result: number[] = [];
      while (result.length < count) {
        const colorIndex = reader.readBits(bits);
        if (colorIndex >= palette.length) {
          throw new McoImageV3InvalidPayloadError(
            algorithm === McoImageV3BlockAlgorithm.varUintRle
              ? 'Varuint RLE color index out of range'
              : 'Compact RLE color index out of range',
          );
        }
        const length = algorithm === McoImageV3BlockAlgorithm.varUintRle
          ? reader.readBitVarUint()
          : reader.readBoundedCompactUint(count - result.length - 1) + 1;
        if (length <= 0 || result.length + length > count) {
          throw new McoImageV3InvalidPayloadError('Invalid RLE length');
        }
        for (let i = 0; i < length; i++) result.push(palette[colorIndex]);
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.lzPixels: {
      const palette = readLocalPalette(reader, profile);
      const bits = localBits(palette.length);
      const result: number[] = [];
      while (result.length < count) {
        const isMatch = reader.readBits(1) !== 0;
        if (isMatch) {
          const remaining = count - result.length;
          if (result.length === 0 || remaining < MIN_LZ_MATCH_LENGTH) {
            throw new McoImageV3InvalidPayloadError('Invalid LZ pixel match');
          }
          const distance = reader.readRangeCompactUint(result.length - 1) + 1;
          const length = reader.readRangeCompactUint(remaining - MIN_LZ_MATCH_LENGTH) + MIN_LZ_MATCH_LENGTH;
          if (distance > result.length || result.length + length > count) {
            throw new McoImageV3InvalidPayloadError('Invalid LZ pixel match');
          }
          for (let i = 0; i < length; i++) result.push(result[result.length - distance]);
        } else {
          const length = reader.readRangeCompactUint(count - result.length - 1) + 1;
          if (result.length + length > count) {
            throw new McoImageV3InvalidPayloadError('Invalid LZ pixel literal length');
          }
          for (let i = 0; i < length; i++) {
            const colorIndex = reader.readBits(bits);
            if (colorIndex >= palette.length) {
              throw new McoImageV3InvalidPayloadError('LZ pixel color index out of range');
            }
            result.push(palette[colorIndex]);
          }
        }
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.quadtree: {
      if (scan !== ScanMode.h) throw new McoImageV3InvalidPayloadError('Quadtree requires horizontal scan');
      const palette = readLocalPalette(reader, profile);
      const result = new Array<number>(count).fill(palette[0]);
      readQuadtreeNode(reader, result, width, 0, 0, width, height, palette, localBits(palette.length));
      return result;
    }
    case McoImageV3BlockAlgorithm.bitplanes: {
      const palette = readLocalPalette(reader, profile);
      return decodeBitplanesBody(reader, count, palette);
    }
    case McoImageV3BlockAlgorithm.adaptiveBitplanes: {
      const palette = readLocalPalette(reader, profile);
      return decodeAdaptiveBitplanesBody(reader, count, palette);
    }
    case McoImageV3BlockAlgorithm.directBitplanes:
      if (isGrayscaleProfile(profile)) {
        return decodeAdaptiveBitplanesBody(reader, count, Array.from({ length: paletteSize(profile) }, (_, i) => i));
      }
      if (isDynamicProfile(profile)) {
        return decodeAdaptiveBitplanesBody(reader, count, dynamicProfilePalette(profile));
      }
      throw new McoImageV3InvalidPayloadError('Direct bitplanes require a grayscale or dynamic profile');
    case McoImageV3BlockAlgorithm.rowDelta: {
      const palette = readLocalPalette(reader, profile);
      const local = readRowDeltaBody(
        reader, count, rowLengthForScan(scan, width, height), localBits(palette.length), palette.length - 1,
      );
      return mapLocalPixels(local, palette, 'Row-delta color index out of range');
    }
    case McoImageV3BlockAlgorithm.compactRowDelta: {
      const palette = readLocalPalette(reader, profile);
      const local = readCompactRowDeltaBody(
        reader, count, rowLengthForScan(scan, width, height), localBits(palette.length), false, palette.length - 1,
      );
      return mapLocalPixels(local, palette, 'Compact row-delta color index out of range');
    }
    case McoImageV3BlockAlgorithm.directRowDelta:
      if (isGrayscaleProfile(profile)) {
        return readCompactRowDeltaBody(
          reader, count, rowLengthForScan(scan, width, height), globalBits(profile), true, paletteSize(profile) - 1,
        );
      }
      if (isDynamicProfile(profile)) {
        const profilePixels = readCompactRowDeltaBody(
          reader, count, rowLengthForScan(scan, width, height), globalBits(profile), false, paletteSize(profile) - 1,
        );
        const palette = dynamicProfilePalette(profile);
        return profilePixels.map((index) => palette[index]);
      }
      throw new McoImageV3InvalidPayloadError('Direct row-delta requires a grayscale or dynamic profile');
    case McoImageV3BlockAlgorithm.varUintSparse:
    case McoImageV3BlockAlgorithm.compactSparse: {
      const background = inheritedBackgroundColor == null
        ? readBackgroundRef(reader, profile, implicitWhiteBackground)
        : inheritedBackgroundColor;
      const palette = readLocalPalette(reader, profile);
      if (palette.includes(background)) {
        throw new McoImageV3InvalidPayloadError('Sparse palette contains background');
      }
      const bits = localBits(palette.length);
      const result = new Array<number>(count).fill(background);
      const segmentCount = algorithm === McoImageV3BlockAlgorithm.varUintSparse
        ? reader.readBitVarUint()
        : reader.readBoundedCompactUint(count - 1) + 1;
      if (segmentCount <= 0 || segmentCount > count) {
        throw new McoImageV3InvalidPayloadError('Invalid sparse segment count');
      }
      let pos = 0;
      for (let i = 0; i < segmentCount; i++) {
        if (algorithm === McoImageV3BlockAlgorithm.varUintSparse) {
          const skip = reader.readBitVarUint();
          if (skip > count - pos) throw new McoImageV3InvalidPayloadError('Invalid varuint sparse skip');
          pos += skip;
          if (pos >= count) throw new McoImageV3InvalidPayloadError('Invalid varuint sparse segment start');
        } else {
          if (pos >= count) throw new McoImageV3InvalidPayloadError('Invalid compact sparse segment count');
          pos += reader.readBoundedCompactUint(count - pos - 1);
        }
        const colorIndex = reader.readBits(bits);
        if (colorIndex >= palette.length) {
          throw new McoImageV3InvalidPayloadError('Sparse color index out of range');
        }
        const length = algorithm === McoImageV3BlockAlgorithm.varUintSparse
          ? reader.readBitVarUint()
          : reader.readBoundedCompactUint(count - pos - 1) + 1;
        if (length <= 0 || pos + length > count) {
          throw new McoImageV3InvalidPayloadError('Invalid sparse segment length');
        }
        for (let j = 0; j < length; j++) result[pos + j] = palette[colorIndex];
        pos += length;
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.biColorMask: {
      const background = inheritedBackgroundColor == null
        ? readBackgroundRef(reader, profile, implicitWhiteBackground)
        : inheritedBackgroundColor;
      const foreground = readColorRef(reader, profile);
      const result: number[] = [];
      for (let i = 0; i < count; i++) result.push(reader.readBits(1) !== 0 ? foreground : background);
      return result;
    }
    case McoImageV3BlockAlgorithm.rowRepeat: {
      const palette = readLocalPalette(reader, profile);
      const local = readRowRepeat(
        reader, count, rowLengthForScan(scan, width, height), localBits(palette.length),
      );
      return mapLocalPixels(local, palette, 'Row-repeat color index out of range');
    }
    default:
      throw new McoImageV3InvalidPayloadError(`Unsupported MCOimg v3 algorithm ${algorithm}`);
  }
}

export function decodeBlockBodyWithSharedPalette(
  reader: BitReader,
  width: number,
  height: number,
  algorithm: McoImageV3BlockAlgorithmId,
  scan: ScanModeId,
  palette: readonly number[],
  backgroundColor: number,
) {
  const count = width * height;
  const bits = localBits(palette.length);
  switch (algorithm) {
    case McoImageV3BlockAlgorithm.rawLocal: {
      const local = [];
      for (let i = 0; i < count; i++) local.push(reader.readBits(bits));
      return mapLocalPixels(local, palette);
    }
    case McoImageV3BlockAlgorithm.varUintRle:
    case McoImageV3BlockAlgorithm.compactRle: {
      const result: number[] = [];
      while (result.length < count) {
        const colorIndex = reader.readBits(bits);
        if (colorIndex >= palette.length) {
          throw new McoImageV3InvalidPayloadError('Shared RLE palette index out of range');
        }
        const length = algorithm === McoImageV3BlockAlgorithm.varUintRle
          ? reader.readBitVarUint()
          : reader.readBoundedCompactUint(count - result.length - 1) + 1;
        if (length <= 0 || result.length + length > count) {
          throw new McoImageV3InvalidPayloadError('Invalid shared RLE length');
        }
        for (let i = 0; i < length; i++) result.push(palette[colorIndex]);
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.varUintSparse:
    case McoImageV3BlockAlgorithm.compactSparse: {
      const segmentCount = algorithm === McoImageV3BlockAlgorithm.varUintSparse
        ? reader.readBitVarUint()
        : reader.readBoundedCompactUint(count - 1) + 1;
      if (segmentCount <= 0 || segmentCount > count) {
        throw new McoImageV3InvalidPayloadError('Invalid shared sparse segment count');
      }
      const result = new Array<number>(count).fill(backgroundColor);
      let pos = 0;
      for (let i = 0; i < segmentCount; i++) {
        if (algorithm === McoImageV3BlockAlgorithm.varUintSparse) {
          const skip = reader.readBitVarUint();
          if (skip > count - pos) throw new McoImageV3InvalidPayloadError('Invalid shared varuint sparse skip');
          pos += skip;
          if (pos >= count) throw new McoImageV3InvalidPayloadError('Invalid shared varuint sparse segment start');
        } else {
          if (pos >= count) throw new McoImageV3InvalidPayloadError('Invalid shared compact sparse segment count');
          pos += reader.readBoundedCompactUint(count - pos - 1);
        }
        const colorIndex = reader.readBits(bits);
        if (colorIndex >= palette.length || palette[colorIndex] === backgroundColor) {
          throw new McoImageV3InvalidPayloadError('Invalid shared sparse color');
        }
        const length = algorithm === McoImageV3BlockAlgorithm.varUintSparse
          ? reader.readBitVarUint()
          : reader.readBoundedCompactUint(count - pos - 1) + 1;
        if (length <= 0 || pos + length > count) {
          throw new McoImageV3InvalidPayloadError('Invalid shared sparse segment length');
        }
        for (let j = 0; j < length; j++) result[pos + j] = palette[colorIndex];
        pos += length;
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.lzPixels: {
      const result: number[] = [];
      while (result.length < count) {
        const isMatch = reader.readBits(1) !== 0;
        if (isMatch) {
          const remaining = count - result.length;
          if (result.length === 0 || remaining < MIN_LZ_MATCH_LENGTH) {
            throw new McoImageV3InvalidPayloadError('Invalid LZ pixel match');
          }
          const distance = reader.readRangeCompactUint(result.length - 1) + 1;
          const length = reader.readRangeCompactUint(remaining - MIN_LZ_MATCH_LENGTH) + MIN_LZ_MATCH_LENGTH;
          if (distance > result.length || result.length + length > count) {
            throw new McoImageV3InvalidPayloadError('Invalid LZ pixel match');
          }
          for (let i = 0; i < length; i++) result.push(result[result.length - distance]);
        } else {
          const length = reader.readRangeCompactUint(count - result.length - 1) + 1;
          for (let i = 0; i < length; i++) {
            const colorIndex = reader.readBits(bits);
            if (colorIndex >= palette.length) {
              throw new McoImageV3InvalidPayloadError('LZ shared palette index out of range');
            }
            result.push(palette[colorIndex]);
          }
        }
      }
      return result;
    }
    case McoImageV3BlockAlgorithm.quadtree: {
      if (scan !== ScanMode.h) throw new McoImageV3InvalidPayloadError('Quadtree requires horizontal scan');
      const result = new Array<number>(count).fill(palette[0]);
      readQuadtreeNode(reader, result, width, 0, 0, width, height, palette, bits);
      return result;
    }
    case McoImageV3BlockAlgorithm.bitplanes:
      return decodeBitplanesBody(reader, count, palette);
    case McoImageV3BlockAlgorithm.adaptiveBitplanes:
      return decodeAdaptiveBitplanesBody(reader, count, palette);
    case McoImageV3BlockAlgorithm.rowDelta:
      return mapLocalPixels(
        readRowDeltaBody(reader, count, rowLengthForScan(scan, width, height), bits, palette.length - 1),
        palette,
      );
    case McoImageV3BlockAlgorithm.compactRowDelta:
      return mapLocalPixels(
        readCompactRowDeltaBody(reader, count, rowLengthForScan(scan, width, height), bits, false, palette.length - 1),
        palette,
      );
    case McoImageV3BlockAlgorithm.biColorMask: {
      const foregroundIndex = reader.readBits(bits);
      if (foregroundIndex >= palette.length) {
        throw new McoImageV3InvalidPayloadError('Invalid shared bi-color foreground');
      }
      const foreground = palette[foregroundIndex];
      if (foreground === backgroundColor) {
        throw new McoImageV3InvalidPayloadError('Shared bi-color foreground equals background');
      }
      const result: number[] = [];
      for (let i = 0; i < count; i++) result.push(reader.readBits(1) !== 0 ? foreground : backgroundColor);
      return result;
    }
    case McoImageV3BlockAlgorithm.rowRepeat:
      return mapLocalPixels(
        readRowRepeat(reader, count, rowLengthForScan(scan, width, height), bits),
        palette,
      );
    default:
      throw new McoImageV3InvalidPayloadError(
        'MCOimg v3 algorithm cannot use a shared region palette',
      );
  }
}

