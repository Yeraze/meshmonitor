/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 3096-3561
 *          (row delta and compact row delta)
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
import type { RowChange, RowDeltaDecision, CompactRowDeltaDecision, CompactValueEncoding } from './types.js';
import { BitWriter } from './bitWriter.js';
import { bitLength } from '../bitReader.js';
import { compactRowDeltaPredictedValue } from '../blockBodies.js';
import {
  COMPACT_ROW_DELTA_OP_BITS,
  COMPACT_ROW_DELTA_OP_INDEXED,
  COMPACT_ROW_DELTA_OP_PREDICTED,
  COMPACT_ROW_DELTA_OP_RAW,
  COMPACT_ROW_DELTA_OP_REPEAT,
  COMPACT_ROW_DELTA_OP_REPEAT_RUN,
  COMPACT_ROW_DELTA_OP_SAME_SCALAR,
  COMPACT_ROW_DELTA_OP_SEGMENTS,
  COMPACT_ROW_DELTA_OP_TRIMMED_MASK,
  ROW_DELTA_EXTENDED_BITS,
  ROW_DELTA_EXTENDED_MASK,
  ROW_DELTA_EXTENDED_REPEAT_RUN,
  ROW_DELTA_EXTENDED_SAME_SCALAR_MASK,
  ROW_DELTA_EXTENDED_SEGMENTS,
  ROW_DELTA_OP_BITS,
  ROW_DELTA_OP_EXTENDED,
  ROW_DELTA_OP_INDEXED,
  ROW_DELTA_OP_RAW,
  ROW_DELTA_OP_REPEAT,
  ROW_DELTA_PREDICTOR_LEFT,
  ROW_DELTA_PREDICTOR_RIGHT,
  ROW_DELTA_PREDICTOR_SAME,
} from '../constants.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';
import { compactUintBitLength, rangeCompactUintBitLength } from './localPaletteWriter.js';

export function encoderRowDeltaSegments(changes: RowChange[]) {
  if (changes.length === 0) return [];
  const segments = [];
  let start = changes[0].x;
  let values = [changes[0].value];
  let previous = start;
  for (let i = 1; i < changes.length; i++) {
    const change = changes[i];
    if (change.x === previous + 1) values.push(change.value);
    else { segments.push({ x: start, length: values.length, values }); start = change.x; values = [change.value]; }
    previous = change.x;
  }
  segments.push({ x: start, length: values.length, values });
  return segments;
}

export function encoderSameRowDeltaValue(changes: RowChange[]) {
  if (changes.length === 0) return null;
  const value = changes[0].value;
  for (let i = 1; i < changes.length; i++) if (changes[i].value !== value) return null;
  return value;
}

export function encoderRowDeltaChanges(values: number[], rowLength: number, row: number, useVirtualBaseRow: boolean, predictor: number) {
  const changes = [];
  const rowStart = row * rowLength;
  for (let x = 0; x < rowLength; x++) {
    const predicted = compactRowDeltaPredictedValue(values, rowLength, row, x, predictor, useVirtualBaseRow);
    if (values[rowStart + x] !== predicted) changes.push({ x, value: values[rowStart + x] });
  }
  return changes;
}

export function encoderRowDeltaPredictors(row: number, useVirtualBaseRow: boolean) {
  return row === 0 && useVirtualBaseRow
    ? [ROW_DELTA_PREDICTOR_SAME]
    : [ROW_DELTA_PREDICTOR_SAME, ROW_DELTA_PREDICTOR_LEFT, ROW_DELTA_PREDICTOR_RIGHT];
}

export function encoderCompactPredictorBitCost(predictor: number) {
  return predictor === ROW_DELTA_PREDICTOR_SAME ? 1 : 2;
}

export function writeEncoderCompactPredictor(writer: BitWriter, predictor: number) {
  if (predictor === ROW_DELTA_PREDICTOR_SAME) writer.writeBits(0, 1);
  else if (predictor === ROW_DELTA_PREDICTOR_LEFT) writer.writeBits(1, 2);
  else if (predictor === ROW_DELTA_PREDICTOR_RIGHT) writer.writeBits(3, 2);
  else throw new MCOImageV3InvalidInputError('Invalid row-delta predictor');
}

export function encoderRepeatedRowCount(values: number[], rowLength: number, row: number, useVirtualBaseRow: boolean) {
  const rowCount = values.length / rowLength;
  let count = 0;
  while (row + count < rowCount) {
    const current = row + count;
    let same = true;
    for (let x = 0; x < rowLength; x++) {
      if (values[current * rowLength + x] !== compactRowDeltaPredictedValue(
        values, rowLength, current, x, ROW_DELTA_PREDICTOR_SAME, useVirtualBaseRow,
      )) { same = false; break; }
    }
    if (!same) break;
    count++;
  }
  return count;
}

export function bestEncoderRowDeltaDecision(values: number[], rowLength: number, valueBits: number, row: number, useVirtualBaseRow: boolean, allowShiftPredictors: boolean) {
  let best: RowDeltaDecision = {
    op: ROW_DELTA_OP_RAW, extendedOp: -1, predictor: ROW_DELTA_PREDICTOR_SAME,
    changes: [], bitCost: ROW_DELTA_OP_BITS + rowLength * valueBits,
  };
  const predictors = allowShiftPredictors
    ? encoderRowDeltaPredictors(row, useVirtualBaseRow)
    : [ROW_DELTA_PREDICTOR_SAME];
  for (const predictor of predictors) {
    const changes = encoderRowDeltaChanges(values, rowLength, row, useVirtualBaseRow, predictor);
    if (changes.length === 0 && predictor === ROW_DELTA_PREDICTOR_SAME) {
      const bitCost = ROW_DELTA_OP_BITS;
      if (bitCost < best.bitCost) best = { op: ROW_DELTA_OP_REPEAT, extendedOp: -1, predictor, changes, bitCost };
      continue;
    }
    const predictorCost = allowShiftPredictors ? encoderCompactPredictorBitCost(predictor) : 0;
    const positionBits = bitLength(rowLength - 1);
    const indexedCost = ROW_DELTA_OP_BITS + predictorCost + bitLength(rowLength) +
      changes.length * (positionBits + valueBits);
    if (indexedCost < best.bitCost) best = { op: ROW_DELTA_OP_INDEXED, extendedOp: -1, predictor, changes, bitCost: indexedCost };
    if (changes.length === 0) continue;
    const maskCost = ROW_DELTA_OP_BITS + ROW_DELTA_EXTENDED_BITS + predictorCost + rowLength + changes.length * valueBits;
    if (maskCost < best.bitCost) best = { op: ROW_DELTA_OP_EXTENDED, extendedOp: ROW_DELTA_EXTENDED_MASK, predictor, changes, bitCost: maskCost };
    const segments = encoderRowDeltaSegments(changes);
    const segmentCost = ROW_DELTA_OP_BITS + ROW_DELTA_EXTENDED_BITS + predictorCost +
      bitLength(rowLength - 1) + segments.length * positionBits * 2 + changes.length * valueBits;
    if (segmentCost < best.bitCost) best = { op: ROW_DELTA_OP_EXTENDED, extendedOp: ROW_DELTA_EXTENDED_SEGMENTS, predictor, changes, bitCost: segmentCost };
    if (encoderSameRowDeltaValue(changes) != null) {
      const sameCost = ROW_DELTA_OP_BITS + ROW_DELTA_EXTENDED_BITS + predictorCost + rowLength + valueBits;
      if (sameCost < best.bitCost) best = { op: ROW_DELTA_OP_EXTENDED, extendedOp: ROW_DELTA_EXTENDED_SAME_SCALAR_MASK, predictor, changes, bitCost: sameCost };
    }
  }
  return best;
}

export function rowDeltaVariantBitCost(values: number[], rowLength: number, valueBits: number, useVirtualBaseRow: boolean, allowShiftPredictors: boolean) {
  let cost = useVirtualBaseRow ? 0 : rowLength * valueBits;
  const rowCount = values.length / rowLength;
  let row = useVirtualBaseRow ? 0 : 1;
  while (row < rowCount) {
    const repeatCount = encoderRepeatedRowCount(values, rowLength, row, useVirtualBaseRow);
    if (repeatCount >= 2) {
      const repeatRunCost = ROW_DELTA_OP_BITS + ROW_DELTA_EXTENDED_BITS + rangeCompactUintBitLength(repeatCount - 2, rowCount - row - 2);
      if (repeatRunCost < repeatCount * ROW_DELTA_OP_BITS) { cost += repeatRunCost; row += repeatCount; continue; }
    }
    cost += bestEncoderRowDeltaDecision(values, rowLength, valueBits, row, useVirtualBaseRow, allowShiftPredictors).bitCost;
    row++;
  }
  return cost;
}

export function writeEncoderRowDeltaMask(writer: BitWriter, changes: RowChange[], rowLength: number, valueBits: number, sameScalar: boolean) {
  let ci = 0;
  for (let x = 0; x < rowLength; x++) {
    const changed = ci < changes.length && changes[ci].x === x;
    writer.writeBits(changed ? 1 : 0, 1);
    if (changed) ci++;
  }
  if (sameScalar) writer.writeBits(encoderSameRowDeltaValue(changes) as number, valueBits);
  else for (const change of changes) writer.writeBits(change.value, valueBits);
}

export function writeEncoderRowDeltaSegments(writer: BitWriter, changes: RowChange[], rowLength: number, valueBits: number) {
  const segments = encoderRowDeltaSegments(changes);
  const positionBits = bitLength(rowLength - 1);
  writer.writeBits(segments.length - 1, bitLength(rowLength - 1));
  for (const segment of segments) {
    writer.writeBits(segment.x, positionBits);
    writer.writeBits(segment.length - 1, positionBits);
    for (const value of segment.values) writer.writeBits(value, valueBits);
  }
}

export function writeEncoderRowDeltaDecision(writer: BitWriter, values: number[], rowLength: number, valueBits: number, row: number, decision: RowDeltaDecision, allowShiftPredictors: boolean) {
  writer.writeBits(decision.op, ROW_DELTA_OP_BITS);
  if (decision.op === ROW_DELTA_OP_REPEAT) return;
  if (decision.op === ROW_DELTA_OP_RAW) {
    const start = row * rowLength;
    for (let x = 0; x < rowLength; x++) writer.writeBits(values[start + x], valueBits);
    return;
  }
  if (decision.op === ROW_DELTA_OP_INDEXED) {
    if (allowShiftPredictors) writeEncoderCompactPredictor(writer, decision.predictor);
    writer.writeBits(decision.changes.length, bitLength(rowLength));
    const positionBits = bitLength(rowLength - 1);
    for (const change of decision.changes) {
      writer.writeBits(change.x, positionBits);
      writer.writeBits(change.value, valueBits);
    }
    return;
  }
  if (decision.op !== ROW_DELTA_OP_EXTENDED || decision.extendedOp === ROW_DELTA_EXTENDED_REPEAT_RUN) {
    throw new MCOImageV3InvalidInputError('Invalid row-delta decision');
  }
  writer.writeBits(decision.extendedOp, ROW_DELTA_EXTENDED_BITS);
  if (allowShiftPredictors) writeEncoderCompactPredictor(writer, decision.predictor);
  if (decision.extendedOp === ROW_DELTA_EXTENDED_MASK) writeEncoderRowDeltaMask(writer, decision.changes, rowLength, valueBits, false);
  else if (decision.extendedOp === ROW_DELTA_EXTENDED_SEGMENTS) writeEncoderRowDeltaSegments(writer, decision.changes, rowLength, valueBits);
  else if (decision.extendedOp === ROW_DELTA_EXTENDED_SAME_SCALAR_MASK) writeEncoderRowDeltaMask(writer, decision.changes, rowLength, valueBits, true);
  else throw new MCOImageV3InvalidInputError('Invalid row-delta extended op');
}

export function writeEncoderRowDeltaVariant(writer: BitWriter, values: number[], rowLength: number, valueBits: number, useVirtualBaseRow: boolean, allowShiftPredictors: boolean) {
  if (!useVirtualBaseRow) for (let x = 0; x < rowLength; x++) writer.writeBits(values[x], valueBits);
  const rowCount = values.length / rowLength;
  let row = useVirtualBaseRow ? 0 : 1;
  while (row < rowCount) {
    const repeatCount = encoderRepeatedRowCount(values, rowLength, row, useVirtualBaseRow);
    if (repeatCount >= 2) {
      const repeatRunCost = ROW_DELTA_OP_BITS + ROW_DELTA_EXTENDED_BITS + rangeCompactUintBitLength(repeatCount - 2, rowCount - row - 2);
      if (repeatRunCost < repeatCount * ROW_DELTA_OP_BITS) {
        writer.writeBits(ROW_DELTA_OP_EXTENDED, ROW_DELTA_OP_BITS);
        writer.writeBits(ROW_DELTA_EXTENDED_REPEAT_RUN, ROW_DELTA_EXTENDED_BITS);
        writer.writeRangeCompactUint(repeatCount - 2, rowCount - row - 2);
        row += repeatCount;
        continue;
      }
    }
    writeEncoderRowDeltaDecision(writer, values, rowLength, valueBits, row,
      bestEncoderRowDeltaDecision(values, rowLength, valueBits, row, useVirtualBaseRow, allowShiftPredictors),
      allowShiftPredictors);
    row++;
  }
}

export function writeRowDeltaBodyEncoder(writer: BitWriter, values: number[], rowLength: number, valueBits: number) {
  if (rowLength <= 0 || values.length % rowLength !== 0) throw new MCOImageV3InvalidInputError('Invalid row-delta geometry');
  if (values.length === 0) return;
  const costs: Record<string, number> = {};
  for (const shift of [false, true]) for (const virtual of [false, true]) {
    costs[`${shift}:${virtual}`] = rowDeltaVariantBitCost(values, rowLength, valueBits, virtual, shift);
  }
  const noShiftCost = Math.min(costs['false:false'], costs['false:true']);
  const shiftCost = Math.min(costs['true:false'], costs['true:true']);
  const allowShift = shiftCost < noShiftCost;
  const useVirtual = allowShift
    ? costs['true:true'] < costs['true:false']
    : costs['false:true'] < costs['false:false'];
  writer.writeBits(useVirtual ? 1 : 0, 1);
  writer.writeBits(allowShift ? 1 : 0, 1);
  writeEncoderRowDeltaVariant(writer, values, rowLength, valueBits, useVirtual, allowShift);
}

export function encoderGrayscaleDeltaCode(delta: number) {
  if (delta === 0) return 0;
  return delta > 0 ? delta * 2 - 1 : (-delta) * 2;
}

export function encoderCompactGrayscaleDelta(values: number[], rowLength: number, row: number, change: RowChange, predictor: number, useVirtualBaseRow: boolean) {
  return change.value - compactRowDeltaPredictedValue(
    values, rowLength, row, change.x, predictor, useVirtualBaseRow,
  );
}

export function encoderCompactChangePositionsBitCost(changes: RowChange[], rowLength: number) {
  let cost = 0;
  let previousX = -1;
  for (let i = 0; i < changes.length; i++) {
    const remaining = changes.length - i - 1;
    const maxGap = rowLength - previousX - remaining - 2;
    cost += rangeCompactUintBitLength(changes[i].x - previousX - 1, maxGap);
    previousX = changes[i].x;
  }
  return cost;
}

export function bestEncoderCompactValueEncoding(values: number[], rowLength: number, row: number, changes: RowChange[], valueBits: number, predictor: number, useVirtualBaseRow: boolean, directGrayscale: boolean): CompactValueEncoding {
  const absoluteCost = changes.length * valueBits;
  if (!directGrayscale) return { useResidual: false, bitCost: absoluteCost };
  let residualCost = 0;
  for (const change of changes) {
    const code = encoderGrayscaleDeltaCode(encoderCompactGrayscaleDelta(
      values, rowLength, row, change, predictor, useVirtualBaseRow,
    ));
    if (code <= 0) return { useResidual: false, bitCost: 1 + absoluteCost };
    residualCost += compactUintBitLength(code - 1);
  }
  return residualCost < absoluteCost
    ? { useResidual: true, bitCost: 1 + residualCost }
    : { useResidual: false, bitCost: 1 + absoluteCost };
}

export function bestEncoderCompactSameScalarEncoding(values: number[], rowLength: number, row: number, changes: RowChange[], valueBits: number, predictor: number, useVirtualBaseRow: boolean, directGrayscale: boolean): CompactValueEncoding | null {
  const absolute = encoderSameRowDeltaValue(changes);
  const best: CompactValueEncoding | null = absolute == null ? null : { useResidual: false, bitCost: valueBits + (directGrayscale ? 1 : 0) };
  // The wire op assigns one decoded scalar to every changed position.
  // Residual form is therefore representable only when the final absolute
  // value is shared as well; equal deltas alone are insufficient when the
  // predictor varies across positions.
  if (!directGrayscale || absolute == null) return best;
  let sharedDelta = null;
  for (const change of changes) {
    const delta = encoderCompactGrayscaleDelta(values, rowLength, row, change, predictor, useVirtualBaseRow);
    if (sharedDelta != null && sharedDelta !== delta) return best;
    sharedDelta = delta;
  }
  const code = encoderGrayscaleDeltaCode(sharedDelta as number);
  if (code <= 0) return best;
  const residual: CompactValueEncoding = { useResidual: true, bitCost: 1 + compactUintBitLength(code - 1) };
  return residual.bitCost < best!.bitCost ? residual : best;
}

export function bestEncoderCompactRowDeltaDecision(values: number[], rowLength: number, valueBits: number, row: number, useVirtualBaseRow: boolean, directGrayscale: boolean) {
  let best: CompactRowDeltaDecision = {
    op: COMPACT_ROW_DELTA_OP_RAW, predictor: ROW_DELTA_PREDICTOR_SAME,
    changes: [], useResidual: false,
    bitCost: COMPACT_ROW_DELTA_OP_BITS + rowLength * valueBits,
  };
  for (const predictor of encoderRowDeltaPredictors(row, useVirtualBaseRow)) {
    const changes = encoderRowDeltaChanges(values, rowLength, row, useVirtualBaseRow, predictor);
    if (changes.length === 0) {
      const decision: CompactRowDeltaDecision = {
        op: predictor === ROW_DELTA_PREDICTOR_SAME ? COMPACT_ROW_DELTA_OP_REPEAT : COMPACT_ROW_DELTA_OP_PREDICTED,
        predictor, changes, useResidual: false,
        bitCost: COMPACT_ROW_DELTA_OP_BITS + (predictor === ROW_DELTA_PREDICTOR_SAME ? 0 : encoderCompactPredictorBitCost(predictor)),
      };
      if (decision.bitCost < best.bitCost) best = decision;
      continue;
    }
    const predictorCost = encoderCompactPredictorBitCost(predictor);
    const positionCost = encoderCompactChangePositionsBitCost(changes, rowLength);
    const valuesEncoding = bestEncoderCompactValueEncoding(
      values, rowLength, row, changes, valueBits, predictor, useVirtualBaseRow, directGrayscale,
    );
    const indexedCost = COMPACT_ROW_DELTA_OP_BITS + predictorCost +
      rangeCompactUintBitLength(changes.length - 1, rowLength - 1) + positionCost + valuesEncoding.bitCost;
    if (indexedCost < best.bitCost) best = {
      op: COMPACT_ROW_DELTA_OP_INDEXED, predictor, changes,
      useResidual: valuesEncoding.useResidual, bitCost: indexedCost,
    };
    const sameScalar = bestEncoderCompactSameScalarEncoding(
      values, rowLength, row, changes, valueBits, predictor, useVirtualBaseRow, directGrayscale,
    );
    if (sameScalar) {
      const sameCost = COMPACT_ROW_DELTA_OP_BITS + predictorCost +
        rangeCompactUintBitLength(changes.length - 1, rowLength - 1) + positionCost + sameScalar.bitCost;
      if (sameCost < best.bitCost) best = {
        op: COMPACT_ROW_DELTA_OP_SAME_SCALAR, predictor, changes,
        useResidual: sameScalar.useResidual, bitCost: sameCost,
      };
    }
    const segments = encoderRowDeltaSegments(changes);
    let geometryCost = rangeCompactUintBitLength(segments.length - 1, rowLength - 1);
    let previousEnd = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const remaining = segments.length - i - 1;
      const gap = segment.x - previousEnd;
      const maxGap = rowLength - previousEnd - remaining - 1;
      const maxLength = rowLength - segment.x - remaining;
      geometryCost += rangeCompactUintBitLength(gap, maxGap) +
        rangeCompactUintBitLength(segment.length - 1, maxLength - 1);
      previousEnd = segment.x + segment.length;
    }
    const segmentCost = COMPACT_ROW_DELTA_OP_BITS + predictorCost + geometryCost + valuesEncoding.bitCost;
    if (segmentCost < best.bitCost) best = {
      op: COMPACT_ROW_DELTA_OP_SEGMENTS, predictor, changes,
      useResidual: valuesEncoding.useResidual, bitCost: segmentCost,
    };
    const span = changes[changes.length - 1].x - changes[0].x + 1;
    const maskCost = COMPACT_ROW_DELTA_OP_BITS + predictorCost +
      rangeCompactUintBitLength(changes[0].x, rowLength - 1) +
      rangeCompactUintBitLength(span - 1, rowLength - changes[0].x - 1) +
      span + valuesEncoding.bitCost;
    if (maskCost < best.bitCost) best = {
      op: COMPACT_ROW_DELTA_OP_TRIMMED_MASK, predictor, changes,
      useResidual: valuesEncoding.useResidual, bitCost: maskCost,
    };
  }
  return best;
}

export function compactRowDeltaVariantBitCost(values: number[], rowLength: number, valueBits: number, directGrayscale: boolean, useVirtualBaseRow: boolean) {
  let cost = useVirtualBaseRow ? 0 : rowLength * valueBits;
  const rowCount = values.length / rowLength;
  let row = useVirtualBaseRow ? 0 : 1;
  while (row < rowCount) {
    const repeatCount = encoderRepeatedRowCount(values, rowLength, row, useVirtualBaseRow);
    if (repeatCount >= 2) {
      cost += COMPACT_ROW_DELTA_OP_BITS + rangeCompactUintBitLength(repeatCount - 2, rowCount - row - 2);
      row += repeatCount;
    } else {
      cost += bestEncoderCompactRowDeltaDecision(
        values, rowLength, valueBits, row, useVirtualBaseRow, directGrayscale,
      ).bitCost;
      row++;
    }
  }
  return cost;
}

export function writeEncoderCompactChangePositions(writer: BitWriter, changes: RowChange[], rowLength: number) {
  let previousX = -1;
  for (let i = 0; i < changes.length; i++) {
    const remaining = changes.length - i - 1;
    const maxGap = rowLength - previousX - remaining - 2;
    writer.writeRangeCompactUint(changes[i].x - previousX - 1, maxGap);
    previousX = changes[i].x;
  }
}

export function writeEncoderCompactChangedValues(writer: BitWriter, values: number[], rowLength: number, valueBits: number, row: number, changes: RowChange[], predictor: number, useVirtualBaseRow: boolean, useResidual: boolean) {
  for (const change of changes) {
    if (useResidual) {
      const code = encoderGrayscaleDeltaCode(encoderCompactGrayscaleDelta(
        values, rowLength, row, change, predictor, useVirtualBaseRow,
      ));
      writer.writeCompactUint(code - 1);
    } else writer.writeBits(change.value, valueBits);
  }
}

export function writeEncoderCompactRowDeltaDecision(writer: BitWriter, values: number[], rowLength: number, valueBits: number, row: number, decision: CompactRowDeltaDecision, useVirtualBaseRow: boolean, directGrayscale: boolean) {
  writer.writeBits(decision.op, COMPACT_ROW_DELTA_OP_BITS);
  if (decision.op === COMPACT_ROW_DELTA_OP_REPEAT) return;
  const rowStart = row * rowLength;
  if (decision.op === COMPACT_ROW_DELTA_OP_RAW) {
    for (let x = 0; x < rowLength; x++) writer.writeBits(values[rowStart + x], valueBits);
    return;
  }
  writeEncoderCompactPredictor(writer, decision.predictor);
  if (decision.op === COMPACT_ROW_DELTA_OP_PREDICTED) return;
  if (directGrayscale) writer.writeBits(decision.useResidual ? 1 : 0, 1);
  const changes = decision.changes;
  if (decision.op === COMPACT_ROW_DELTA_OP_INDEXED || decision.op === COMPACT_ROW_DELTA_OP_SAME_SCALAR) {
    writer.writeRangeCompactUint(changes.length - 1, rowLength - 1);
    writeEncoderCompactChangePositions(writer, changes, rowLength);
    if (decision.op === COMPACT_ROW_DELTA_OP_SAME_SCALAR) {
      if (decision.useResidual) {
        const code = encoderGrayscaleDeltaCode(encoderCompactGrayscaleDelta(
          values, rowLength, row, changes[0], decision.predictor, useVirtualBaseRow,
        ));
        writer.writeCompactUint(code - 1);
      } else writer.writeBits(changes[0].value, valueBits);
    } else {
      writeEncoderCompactChangedValues(writer, values, rowLength, valueBits, row, changes,
        decision.predictor, useVirtualBaseRow, decision.useResidual);
    }
    return;
  }
  if (decision.op === COMPACT_ROW_DELTA_OP_SEGMENTS) {
    const segments = encoderRowDeltaSegments(changes);
    writer.writeRangeCompactUint(segments.length - 1, rowLength - 1);
    let previousEnd = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const remaining = segments.length - i - 1;
      const gap = segment.x - previousEnd;
      const maxGap = rowLength - previousEnd - remaining - 1;
      const maxLength = rowLength - segment.x - remaining;
      writer.writeRangeCompactUint(gap, maxGap);
      writer.writeRangeCompactUint(segment.length - 1, maxLength - 1);
      previousEnd = segment.x + segment.length;
    }
    writeEncoderCompactChangedValues(writer, values, rowLength, valueBits, row, changes,
      decision.predictor, useVirtualBaseRow, decision.useResidual);
    return;
  }
  if (decision.op === COMPACT_ROW_DELTA_OP_TRIMMED_MASK) {
    const start = changes[0].x;
    const span = changes[changes.length - 1].x - start + 1;
    writer.writeRangeCompactUint(start, rowLength - 1);
    writer.writeRangeCompactUint(span - 1, rowLength - start - 1);
    let ci = 0;
    for (let offset = 0; offset < span; offset++) {
      const changed = ci < changes.length && changes[ci].x === start + offset;
      writer.writeBits(changed ? 1 : 0, 1);
      if (changed) ci++;
    }
    writeEncoderCompactChangedValues(writer, values, rowLength, valueBits, row, changes,
      decision.predictor, useVirtualBaseRow, decision.useResidual);
    return;
  }
  throw new MCOImageV3InvalidInputError('Invalid compact row-delta op');
}

export function writeCompactRowDeltaBodyEncoder(writer: BitWriter, values: number[], rowLength: number, valueBits: number, directGrayscale: boolean) {
  if (rowLength <= 0 || values.length % rowLength !== 0) throw new MCOImageV3InvalidInputError('Invalid compact row-delta geometry');
  const rawCost = compactRowDeltaVariantBitCost(values, rowLength, valueBits, directGrayscale, false);
  const virtualCost = compactRowDeltaVariantBitCost(values, rowLength, valueBits, directGrayscale, true);
  const useVirtual = virtualCost < rawCost;
  writer.writeBits(useVirtual ? 1 : 0, 1);
  if (!useVirtual) for (let x = 0; x < rowLength; x++) writer.writeBits(values[x], valueBits);
  const rowCount = values.length / rowLength;
  let row = useVirtual ? 0 : 1;
  while (row < rowCount) {
    const repeatCount = encoderRepeatedRowCount(values, rowLength, row, useVirtual);
    if (repeatCount >= 2) {
      writer.writeBits(COMPACT_ROW_DELTA_OP_REPEAT_RUN, COMPACT_ROW_DELTA_OP_BITS);
      writer.writeRangeCompactUint(repeatCount - 2, rowCount - row - 2);
      row += repeatCount;
    } else {
      writeEncoderCompactRowDeltaDecision(writer, values, rowLength, valueBits, row,
        bestEncoderCompactRowDeltaDecision(values, rowLength, valueBits, row, useVirtual, directGrayscale),
        useVirtual, directGrayscale);
      row++;
    }
  }
}
