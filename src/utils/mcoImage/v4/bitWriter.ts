/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: bit writer.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 3680-3762
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

/**
 * Bit writer matching V4BitReader (codec 3680-3762). Tests build hostile streams with it;
 * the Phase 3 encoder reuses it. Invalid input throws McoImageV4InvalidPayloadError
 * (upstream: MCOImageInvalidInputException).
 */
export class V4BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private bitOffset = 0;
  bitLength = 0;

  writeBit(value: boolean): void {
    this.writeBits(value ? 1 : 0, 1);
  }

  writeBits(value: number, bits: number): void {
    if (bits < 0 || bits > 32 || value < 0) {
      throw new McoImageV4InvalidPayloadError('Invalid v4 bit field');
    }
    if (bits < 32 && value >= 2 ** bits) {
      throw new McoImageV4InvalidPayloadError('V4 bit field overflow');
    }
    let remaining = bits;
    let source = value;
    while (remaining > 0) {
      const available = 8 - this.bitOffset;
      const take = Math.min(available, remaining);
      const size = 2 ** take;
      this.current |= (source % size) << this.bitOffset;
      source = Math.floor(source / size);
      this.bitOffset += take;
      this.bitLength += take;
      remaining -= take;
      if (this.bitOffset === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitOffset = 0;
      }
    }
  }

  writeCompactUint(value: number): void {
    if (value < 0) throw new McoImageV4InvalidPayloadError('Negative v4 compact uint');
    if (value <= 3) {
      this.writeBits(0, 1);
      this.writeBits(value, 2);
    } else if (value <= 19) {
      this.writeBits(1, 2);
      this.writeBits(value - 4, 4);
    } else if (value <= 275) {
      this.writeBits(3, 3);
      this.writeBits(value - 20, 8);
    } else {
      this.writeBits(7, 3);
      this.writeBitVarUint(value);
    }
  }

  writeBitVarUint(value: number): void {
    let remaining = value;
    do {
      let byte = remaining % 128;
      remaining = Math.floor(remaining / 128);
      if (remaining !== 0) byte |= 0x80;
      this.writeBits(byte, 8);
    } while (remaining !== 0);
  }

  writeBytes(bytes: Uint8Array): void {
    for (const byte of bytes) this.writeBits(byte, 8);
  }

  toBytes(): Uint8Array {
    const result = [...this.bytes];
    if (this.bitOffset !== 0) result.push(this.current);
    return Uint8Array.from(result);
  }
}
