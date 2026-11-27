/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 238-254 and 481-581 (bitLength, bitCount, BitReader)
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
import { McoImageV3InvalidPayloadError } from './errors.js';

export function bitLength(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new McoImageV3InvalidPayloadError('Invalid non-negative integer');
  }
  if (value === 0) return 0;
  return 32 - Math.clz32(value);
}

export function bitCount(value: number): number {
  let current = value >>> 0;
  let count = 0;
  while (current !== 0) {
    count += current & 1;
    current >>>= 1;
  }
  return count;
}

export class BitReader {
  bytes: Uint8Array;
  byteIndex: number;
  bitOffset: number;

  constructor(bytes: Uint8Array, byteIndex = 0) {
    this.bytes = bytes;
    this.byteIndex = byteIndex;
    this.bitOffset = 0;
  }

  readBits(bits: number): number {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new McoImageV3InvalidPayloadError('Invalid bit length');
    }
    let result = 0;
    let shift = 0;
    let remaining = bits;
    while (remaining > 0) {
      if (this.byteIndex >= this.bytes.length) {
        throw new McoImageV3InvalidPayloadError('Unexpected end of bits');
      }
      const available = 8 - this.bitOffset;
      const take = Math.min(available, remaining);
      const mask = take === 32 ? 0xffffffff : (2 ** take) - 1;
      result += (((this.bytes[this.byteIndex] >> this.bitOffset) & mask) * (2 ** shift));
      this.bitOffset += take;
      if (this.bitOffset === 8) {
        this.byteIndex++;
        this.bitOffset = 0;
      }
      shift += take;
      remaining -= take;
    }
    return result;
  }

  readBitVarUint(): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.readBits(8);
      result += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new McoImageV3InvalidPayloadError('Varuint is too long');
  }

  readRangeCompactUint(maxValue: number): number {
    if (!Number.isInteger(maxValue) || maxValue < 0) {
      throw new McoImageV3InvalidPayloadError('Invalid range compact uint limit');
    }
    const value = maxValue <= 7 ? this.readBits(bitLength(maxValue)) : this.readCompactUint();
    if (value > maxValue) {
      throw new McoImageV3InvalidPayloadError('Range compact uint exceeds limit');
    }
    return value;
  }

  readBoundedCompactUint(maxValue: number): number {
    if (!Number.isInteger(maxValue) || maxValue < 0) {
      throw new McoImageV3InvalidPayloadError('Invalid bounded compact uint limit');
    }
    if (maxValue <= 7) return this.readBits(bitLength(maxValue));
    let value: number;
    if (this.readBits(1) === 0) {
      value = this.readBits(2);
    // eslint-disable-next-line no-dupe-else-if -- #6586 ported verbatim: each condition consumes the next bit, so it is not a duplicate
    } else if (this.readBits(1) === 0) {
      value = this.readBits(4) + 4;
    // eslint-disable-next-line no-dupe-else-if -- #6586 ported verbatim: each condition consumes the next bit, so it is not a duplicate
    } else if (this.readBits(1) === 0) {
      value = this.readBits(8) + 20;
    } else {
      if (maxValue < 276) {
        throw new McoImageV3InvalidPayloadError('Invalid bounded compact uint escape');
      }
      value = this.readBits(bitLength(maxValue - 276)) + 276;
    }
    if (value > maxValue) {
      throw new McoImageV3InvalidPayloadError('Bounded compact uint exceeds limit');
    }
    return value;
  }

  readCompactUint(): number {
    if (this.readBits(1) === 0) return this.readBits(2);
    if (this.readBits(1) === 0) return this.readBits(4) + 4;
    if (this.readBits(1) === 0) return this.readBits(8) + 20;
    return this.readBitVarUint();
  }

  finish(): void {
    if (this.bitOffset !== 0) {
      const unusedMask = (0xff << this.bitOffset) & 0xff;
      if ((this.bytes[this.byteIndex] & unusedMask) !== 0) {
        throw new McoImageV3InvalidPayloadError('Non-zero padding bits');
      }
      this.byteIndex++;
      this.bitOffset = 0;
    }
    if (this.byteIndex !== this.bytes.length) {
      throw new McoImageV3InvalidPayloadError('Trailing payload bytes');
    }
  }
}
