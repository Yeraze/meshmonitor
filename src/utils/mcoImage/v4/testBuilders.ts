import { V4BitWriter } from './bitWriter.js';
import { coordinateBits, coordinateMargin, scalarBits } from './primitives.js';

/**
 * Test support: builds small v4 command streams on a square canvas (size <= 64, square64
 * dimension mode). Never imported by decode.ts.
 */
export const zigZagEncode = (v: number): number => (v >= 0 ? v * 2 : -v * 2 - 1);

export class V4TestDoc {
  readonly w = new V4BitWriter();
  readonly xBits: number;
  readonly margin: number;
  readonly scalarBits: number;

  constructor(
    readonly opts: { mixed?: boolean; profile?: number; size?: number } = {},
  ) {
    const size = opts.size ?? 64;
    this.xBits = coordinateBits(size);
    this.margin = coordinateMargin(size);
    this.scalarBits = scalarBits(size, size);
    this.w.writeBits(opts.mixed ? 1 : 0, 2);
    this.w.writeBits(opts.profile ?? 1, 4);
    this.w.writeBits(0, 2); // dimension mode: square64
    this.w.writeBits(size - 1, 6);
    this.w.writeBit(false); // default background
  }

  point(x: number, y: number): this {
    this.w.writeBits(x + this.margin, this.xBits);
    this.w.writeBits(y + this.margin, this.xBits);
    return this;
  }

  dot(x: number, y: number): this {
    this.w.writeBits(4, 4);
    return this.point(x, y);
  }

  repeatLast(dx = 0, dy = 0): this {
    this.w.writeBits(12, 4);
    this.w.writeBits(zigZagEncode(dx), this.xBits + 1);
    this.w.writeBits(zigZagEncode(dy), this.xBits + 1);
    return this;
  }

  /** GROUP command; `inner` writes the nested stream. */
  group(count: number, inner: () => void): this {
    this.w.writeBits(15, 4);
    this.w.writeBits(13, 4);
    this.w.writeCompactUint(count - 1);
    inner();
    return this;
  }

  /** REPEAT_COLOR_RUN, short deltas of zero, no colour changes. */
  colorRun(count: number): this {
    this.w.writeBits(15, 4);
    this.w.writeBits(12, 4);
    this.w.writeBit(false); // fill run
    this.w.writeBit(true); // short deltas
    this.w.writeBits(0, 2);
    this.w.writeBits(0, 3);
    this.w.writeBits(0, 3);
    this.w.writeCompactUint(count - 2);
    this.w.writeBit(false); // no colour changes
    return this;
  }

  /** PATH_ABSOLUTE with every point at (x, y). */
  path(pointCount: number, x: number, y: number, closed = false): this {
    this.w.writeBits(9, 4);
    this.w.writeBit(closed);
    this.w.writeCompactUint(pointCount - (closed ? 3 : 2));
    for (let i = 0; i < pointCount; i++) this.point(x, y);
    return this;
  }

  /** TEXT command carrying a raw MCOtxt-free body is not needed; callers pass prepared bits. */
  rasterLayer(x: number, y: number, high: number, payload: Uint8Array): this {
    this.w.writeBits(15, 4);
    this.w.writeBits(14, 4);
    this.point(x, y);
    this.w.writeBits(high, 4);
    this.w.writeCompactUint(payload.length);
    this.w.writeBytes(payload);
    return this;
  }

  end(): this {
    this.w.writeBits(0, 4);
    return this;
  }

  /** nonce + document bytes, padded to a byte. */
  body(nonce = 7, tail: Uint8Array = new Uint8Array()): Uint8Array {
    const doc = this.w.toBytes();
    const out = new Uint8Array(1 + doc.length + tail.length);
    out[0] = nonce;
    out.set(doc, 1);
    out.set(tail, 1 + doc.length);
    return out;
  }
}
