/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: path readers.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 2697-2925
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
import type { V4BitReader } from './bitReader.js';
import type { V4DecodeBudget } from './budget.js';
import { DELTA_WIDTHS, OP_PATH_DELTA } from './constants.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import type { V4Figure, V4Point, V4Style } from './model.js';
import {
  isCoordinateInRange,
  localCoordinateBits,
  readCoordinate,
  readLocalCoordinate,
  readPoint,
  validateLocalPointInPayload,
  validatePointInPayload,
  zigZagDecode,
} from './primitives.js';
import type { V4Dims } from './primitives.js';

type PathFigure = Extract<V4Figure, { kind: 'path' }>;
type DotFigure = Extract<V4Figure, { kind: 'dot' }>;

/** Codec 2833-2883. Point count is checked against the payload, then charged. */
export function readPath(
  opcode: number,
  reader: V4BitReader,
  style: V4Style,
  d: V4Dims,
  budget: V4DecodeBudget,
): PathFigure {
  const closed = reader.readBit();
  const shortBits = opcode === OP_PATH_DELTA ? DELTA_WIDTHS[reader.readBits(2)] : null;
  const minimum = closed ? 3 : 2;
  const pointCount = reader.readCompactUint() + minimum;
  const minimumBitsPerPoint = shortBits === null ? d.xBits + d.yBits : 2 * (shortBits + 1);
  if (pointCount - 1 > Math.floor(reader.remainingBits / Math.max(1, minimumBitsPerPoint))) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 path point count exceeds payload');
  }
  budget.charge({ points: pointCount });
  const points: V4Point[] = [readPoint(reader, d.width, d.height, d.xBits, d.yBits)];
  while (points.length < pointCount) {
    const previous = points[points.length - 1];
    if (shortBits === null) {
      points.push(readPoint(reader, d.width, d.height, d.xBits, d.yBits));
    } else {
      const x = readPathComponent(reader, previous.x, shortBits, d.xBits, d.width);
      const y = readPathComponent(reader, previous.y, shortBits, d.yBits, d.height);
      points.push({ x, y });
    }
  }
  return { kind: 'path', points, closed, style };
}

/** Codec 2909-2925. */
function readPathComponent(
  reader: V4BitReader,
  previous: number,
  shortBits: number,
  absoluteBits: number,
  axisSize: number,
): number {
  const value = reader.readBit()
    ? readCoordinate(reader, absoluteBits, axisSize)
    : previous + zigZagDecode(reader.readBits(shortBits));
  if (!isCoordinateInRange(value, axisSize)) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 path coordinate is out of range');
  }
  return value;
}

/** Codec 2697-2723. */
export function readOrthogonalPath(reader: V4BitReader, style: V4Style, d: V4Dims, budget: V4DecodeBudget): PathFigure {
  const closed = reader.readBit();
  const shortBits = DELTA_WIDTHS[reader.readBits(2)];
  const minimum = closed ? 3 : 2;
  const pointCount = reader.readCompactUint() + minimum;
  const points: V4Point[] = [readPoint(reader, d.width, d.height, d.xBits, d.yBits)];
  budget.charge({ points: pointCount });
  while (points.length < pointCount) {
    const previous = points[points.length - 1];
    const vertical = reader.readBit();
    const delta = zigZagDecode(reader.readBits(shortBits));
    const point: V4Point = vertical
      ? { x: previous.x, y: previous.y + delta }
      : { x: previous.x + delta, y: previous.y };
    validatePointInPayload(point, d.width, d.height);
    points.push(point);
  }
  return { kind: 'path', points, closed, style };
}

/** Codec 2725-2755. Dots charge as figures and points before they are built. */
export function readDotRun(reader: V4BitReader, style: V4Style, d: V4Dims, budget: V4DecodeBudget): DotFigure[] {
  const deltaEncoded = reader.readBit();
  const shortBits = deltaEncoded ? DELTA_WIDTHS[reader.readBits(2)] : null;
  const pointCount = reader.readCompactUint() + 2;
  const points: V4Point[] = [readPoint(reader, d.width, d.height, d.xBits, d.yBits)];
  budget.charge({ figures: pointCount, points: pointCount });
  while (points.length < pointCount) {
    if (shortBits === null) {
      points.push(readPoint(reader, d.width, d.height, d.xBits, d.yBits));
      continue;
    }
    const previous = points[points.length - 1];
    const point: V4Point = {
      x: previous.x + zigZagDecode(reader.readBits(shortBits)),
      y: previous.y + zigZagDecode(reader.readBits(shortBits)),
    };
    validatePointInPayload(point, d.width, d.height);
    points.push(point);
  }
  return points.map((point): DotFigure => ({ kind: 'dot', point, style }));
}

function readBounds(reader: V4BitReader, d: V4Dims): { origin: V4Point; boundsWidth: number; boundsHeight: number } {
  const origin = readPoint(reader, d.width, d.height, d.xBits, d.yBits);
  const boundsWidth = reader.readBits(d.xBits) + 1;
  const boundsHeight = reader.readBits(d.yBits) + 1;
  if (
    !isCoordinateInRange(origin.x + boundsWidth - 1, d.width) ||
    !isCoordinateInRange(origin.y + boundsHeight - 1, d.height)
  ) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 path bounds are outside the coordinate range');
  }
  return { origin, boundsWidth, boundsHeight };
}

/** Codec 2757-2788. */
export function readBoundsPath(reader: V4BitReader, style: V4Style, d: V4Dims, budget: V4DecodeBudget): PathFigure {
  const closed = reader.readBit();
  const minimum = closed ? 3 : 2;
  const pointCount = reader.readCompactUint() + minimum;
  const { origin, boundsWidth, boundsHeight } = readBounds(reader, d);
  const localXBits = localCoordinateBits(boundsWidth);
  const localYBits = localCoordinateBits(boundsHeight);
  budget.charge({ points: pointCount });
  const points: V4Point[] = [];
  while (points.length < pointCount) {
    points.push({
      x: origin.x + readLocalCoordinate(reader, localXBits, boundsWidth),
      y: origin.y + readLocalCoordinate(reader, localYBits, boundsHeight),
    });
  }
  return { kind: 'path', points, closed, style };
}

/** Codec 2790-2831. */
export function readBoundsDeltaPath(reader: V4BitReader, style: V4Style, d: V4Dims, budget: V4DecodeBudget): PathFigure {
  const closed = reader.readBit();
  const shortBits = DELTA_WIDTHS[reader.readBits(2)];
  const minimum = closed ? 3 : 2;
  const pointCount = reader.readCompactUint() + minimum;
  const { origin, boundsWidth, boundsHeight } = readBounds(reader, d);
  const localXBits = localCoordinateBits(boundsWidth);
  const localYBits = localCoordinateBits(boundsHeight);
  const first: V4Point = {
    x: readLocalCoordinate(reader, localXBits, boundsWidth),
    y: readLocalCoordinate(reader, localYBits, boundsHeight),
  };
  budget.charge({ points: pointCount });
  const localPoints: V4Point[] = [first];
  while (localPoints.length < pointCount) {
    const previous = localPoints[localPoints.length - 1];
    const point: V4Point = {
      x: previous.x + zigZagDecode(reader.readBits(shortBits)),
      y: previous.y + zigZagDecode(reader.readBits(shortBits)),
    };
    validateLocalPointInPayload(point, boundsWidth, boundsHeight);
    localPoints.push(point);
  }
  const points = localPoints.map((point): V4Point => ({ x: origin.x + point.x, y: origin.y + point.y }));
  return { kind: 'path', points, closed, style };
}

/** Codec 2885-2907. */
export function readPointDeltaSequence(reader: V4BitReader, count: number, d: V4Dims): V4Point[] {
  const shortBits = DELTA_WIDTHS[reader.readBits(2)];
  const points: V4Point[] = [readPoint(reader, d.width, d.height, d.xBits, d.yBits)];
  while (points.length < count) {
    const previous = points[points.length - 1];
    const point: V4Point = {
      x: previous.x + zigZagDecode(reader.readBits(shortBits)),
      y: previous.y + zigZagDecode(reader.readBits(shortBits)),
    };
    validatePointInPayload(point, d.width, d.height);
    points.push(point);
  }
  return points;
}
