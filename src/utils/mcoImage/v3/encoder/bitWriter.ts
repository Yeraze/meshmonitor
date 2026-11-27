/**
 * TypeScript port of the MCOimg v3 (IM3) encoder, Normal and High levels.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 2045-2165
 *          (bit writer)
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
import { bitLength } from '../bitReader.js';
import { McoImageV3InvalidInputError as MCOImageV3InvalidInputError } from '../errors.js';

export class BitWriter {
  bytes: number[] = [];
  current = 0;
  bitOffset = 0;

  get bitLength(): number { return this.bytes.length * 8 + this.bitOffset; }

  writeBits(value: number, bits: number): this {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new MCOImageV3InvalidInputError('Invalid bit length');
    }
    if (bits === 0) return this;
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** bits) {
      throw new MCOImageV3InvalidInputError('Value does not fit bits');
    }
    let remaining = bits;
    let sourceShift = 0;
    while (remaining > 0) {
      const take = Math.min(8 - this.bitOffset, remaining);
      const mask = (1 << take) - 1;
      // Output-neutral: for 0 <= value < 2^32 and sourceShift < 32, `value >>> sourceShift` equals
      // upstream's `Math.floor(value / 2 ** sourceShift)` once masked to at most 8 bits.
      this.current |= (((value >>> sourceShift) & mask) << this.bitOffset);
      this.bitOffset += take;
      sourceShift += take;
      remaining -= take;
      if (this.bitOffset === 8) {
        this.bytes.push(this.current & 0xff);
        this.current = 0;
        this.bitOffset = 0;
      }
    }
    return this;
  }

  // Upstream runs `asBytes(bytesLike, 'source bitstream')`; every caller already passes a Uint8Array.
  writeBitStream(bytes: Uint8Array, sourceBitLength: number): this {
    if (!Number.isInteger(sourceBitLength) || sourceBitLength < 0 || sourceBitLength > bytes.length * 8) {
      throw new MCOImageV3InvalidInputError('Invalid source bitstream length');
    }
    let remaining = sourceBitLength;
    let index = 0;
    while (remaining > 0) {
      const take = Math.min(8, remaining);
      this.writeBits(bytes[index] & (2 ** take - 1), take);
      remaining -= take;
      index++;
    }
    return this;
  }

  writeZeroBits(bits: number): this {
    if (!Number.isInteger(bits) || bits < 0) throw new MCOImageV3InvalidInputError('Invalid bit length');
    while (bits > 0) {
      const take = Math.min(bits, 32);
      this.writeBits(0, take);
      bits -= take;
    }
    return this;
  }

  alignToByte(): this {
    if (this.bitOffset !== 0) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.bitOffset = 0;
    }
    return this;
  }

  writeAlignedByte(value: number): this {
    this.alignToByte();
    this.bytes.push(value & 0xff);
    return this;
  }

  writeBitVarUint(value: number): this {
    if (!Number.isInteger(value) || value < 0) throw new MCOImageV3InvalidInputError('Negative varuint');
    let remaining = value;
    do {
      let byte = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
      if (remaining !== 0) byte |= 0x80;
      this.writeBits(byte, 8);
    } while (remaining !== 0);
    return this;
  }

  writeRangeCompactUint(value: number, maxValue: number): this {
    if (!Number.isInteger(maxValue) || !Number.isInteger(value) || maxValue < 0 || value < 0 || value > maxValue) {
      throw new MCOImageV3InvalidInputError('Range compact uint is out of range');
    }
    if (maxValue <= 7) return this.writeBits(value, bitLength(maxValue));
    return this.writeCompactUint(value);
  }

  writeBoundedCompactUint(value: number, maxValue: number): this {
    if (!Number.isInteger(maxValue) || !Number.isInteger(value) || maxValue < 0 || value < 0 || value > maxValue) {
      throw new MCOImageV3InvalidInputError('Bounded compact uint is out of range');
    }
    if (maxValue <= 7) return this.writeBits(value, bitLength(maxValue));
    if (value <= 3) return this.writeBits(0, 1).writeBits(value, 2);
    if (value <= 19) return this.writeBits(1, 2).writeBits(value - 4, 4);
    if (value <= 275) return this.writeBits(3, 3).writeBits(value - 20, 8);
    this.writeBits(7, 3);
    return this.writeBits(value - 276, bitLength(maxValue - 276));
  }

  writeCompactUint(value: number): this {
    if (!Number.isInteger(value) || value < 0) throw new MCOImageV3InvalidInputError('Negative compact uint');
    if (value <= 3) return this.writeBits(0, 1).writeBits(value, 2);
    if (value <= 19) return this.writeBits(1, 2).writeBits(value - 4, 4);
    if (value <= 275) return this.writeBits(3, 3).writeBits(value - 20, 8);
    return this.writeBits(7, 3).writeBitVarUint(value);
  }

  toBytes() {
    this.alignToByte();
    return Uint8Array.from(this.bytes);
  }
}
