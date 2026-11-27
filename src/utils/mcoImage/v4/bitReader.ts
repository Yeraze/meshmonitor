/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: bit and byte readers.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 3764-3905
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
import { McoImageV4InvalidPayloadError } from './errors.js';

/** Bits are read LSB-first within each byte, values LSB-first (codec 3764-3853). */
export class V4BitReader {
  private readonly bytes: Uint8Array;
  private readonly bitLimit: number;
  private bitIndex = 0;

  constructor(bytes: Uint8Array, bitLimit?: number) {
    this.bytes = bytes;
    this.bitLimit = bitLimit ?? bytes.length * 8;
  }

  get remainingBits(): number {
    return this.bitLimit - this.bitIndex;
  }

  get byteOffset(): number {
    return (this.bitIndex + 7) >> 3;
  }

  readBit(): boolean {
    return this.readBits(1) !== 0;
  }

  readBits(bits: number): number {
    if (bits < 0 || bits > 32 || this.bitIndex + bits > this.bitLimit) {
      throw new McoImageV4InvalidPayloadError('Unexpected end of v4 bits');
    }
    let value = 0;
    for (let shift = 0; shift < bits; shift++) {
      const byte = this.bytes[this.bitIndex >> 3];
      // Multiplication, not <<, so a 32-bit field stays unsigned.
      value += ((byte >> (this.bitIndex & 7)) & 1) * 2 ** shift;
      this.bitIndex++;
    }
    return value;
  }

  readCompactUint(): number {
    if (this.readBits(1) === 0) return this.readBits(2);
    if (this.readBits(1) === 0) return this.readBits(4) + 4;
    if (this.readBits(1) === 0) return this.readBits(8) + 20;
    const value = this.readCanonicalBitVarUint();
    if (value <= 275) {
      throw new McoImageV4InvalidPayloadError('Non-canonical v4 compact uint');
    }
    return value;
  }

  readCanonicalBitVarUint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.readBits(8);
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (i > 0 && (byte & 0x7f) === 0) {
          throw new McoImageV4InvalidPayloadError('Non-canonical v4 bit varuint');
        }
        return result;
      }
      shift += 7;
    }
    throw new McoImageV4InvalidPayloadError('V4 bit varuint is too long');
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || length > Math.floor(this.remainingBits / 8)) {
      throw new McoImageV4InvalidPayloadError('Unexpected end of v4 bits');
    }
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.readBits(8);
    return out;
  }

  finish(): void {
    while (this.bitIndex < this.bitLimit) {
      if (this.readBits(1) !== 0) {
        throw new McoImageV4InvalidPayloadError('Non-zero MCOimg v4 padding');
      }
    }
  }

  finishByte(): void {
    const padding = this.bitIndex & 7;
    if (padding === 0) return;
    const remaining = 8 - padding;
    if (this.readBits(remaining) !== 0) {
      throw new McoImageV4InvalidPayloadError('Non-zero MCOimg v4 padding');
    }
  }
}

/** Transport tail reader (codec 3855-3905). */
export class V4ByteReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new McoImageV4InvalidPayloadError('Unexpected end of v4 bytes');
    }
    return this.bytes[this.offset++];
  }

  readCanonicalVarUint7(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.readByte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (i > 0 && (byte & 0x7f) === 0) {
          throw new McoImageV4InvalidPayloadError('Non-canonical v4 byte varuint');
        }
        return result;
      }
      shift += 7;
    }
    throw new McoImageV4InvalidPayloadError('V4 byte varuint is too long');
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || length > this.remaining) {
      throw new McoImageV4InvalidPayloadError('Unexpected end of v4 bytes');
    }
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readUint32Le(): number {
    const b0 = this.readByte();
    const b1 = this.readByte();
    const b2 = this.readByte();
    const b3 = this.readByte();
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
}
