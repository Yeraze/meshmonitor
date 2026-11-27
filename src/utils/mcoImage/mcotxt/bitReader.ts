/**
 * MCOtxt MSB-first bit reader.
 *
 * Ported from https://github.com/HDDen/meshcore-open tag 9.5.1-mod-1.9.0 commit fe375741226588440e268002b4975349b2e95ffe
 *  file   lib/MCOtxt/bit_reader.dart, lines 1-48
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file; only types were added.
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
import { McotxtCodecError } from './errors.js';

export class McotxtBitReader {
  private readonly data: Uint8Array;
  private readonly bitLength: number;
  private bitIndex = 0;

  constructor(data: Uint8Array, bitLength: number) {
    if (!Number.isInteger(bitLength) || bitLength < 0 || bitLength > data.length * 8) {
      throw new McotxtCodecError('invalidInput', 'Invalid bitLength');
    }
    this.data = data;
    this.bitLength = bitLength;
  }

  get remainingBits(): number {
    return this.bitLength - this.bitIndex;
  }

  readBit(): number {
    return this.readBits(1);
  }

  readBits(count: number): number {
    if (count < 0 || count > 32) {
      throw new McotxtCodecError('invalidInput', 'Invalid bit field length');
    }
    if (this.bitIndex + count > this.bitLength) {
      throw new McotxtCodecError('unexpectedEnd', 'Unexpected end of MCOtxt bitstream');
    }
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.bitIndex >> 3] as number;
      const bit = (byte >> (7 - (this.bitIndex & 7))) & 1;
      value = value * 2 + bit;
      this.bitIndex++;
    }
    return value;
  }
}
