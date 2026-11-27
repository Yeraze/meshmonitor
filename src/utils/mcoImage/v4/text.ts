/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: TEXT command.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 2586-2655
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
import { decodeMcotxtStream } from '../mcotxt/decoder.js';
import type { McotxtDecodeResult } from '../mcotxt/decoder.js';
import { MCOTXT_UNSUPPORTED_CODES, McotxtCodecError } from '../mcotxt/errors.js';
import type { V4BitReader } from './bitReader.js';
import type { V4DecodeBudget } from './budget.js';
import { TEXT_ALIGN_BITS, TEXT_MASK_BITS } from './constants.js';
import { McoImageV4InvalidPayloadError, McoImageV4UnsupportedFormatError } from './errors.js';
import type { V4Figure, V4Style, V4TextAlign } from './model.js';
import { readPoint } from './primitives.js';
import type { V4Dims } from './primitives.js';

const ALIGNS: readonly V4TextAlign[] = ['left', 'center', 'right'];

type TextFigure = Extract<V4Figure, { kind: 'text' }>;

/** Codec 2586-2597: source bits are LSB-first, MCOtxt wants MSB-first. */
export function readMcotxtBits(reader: V4BitReader, bitLength: number): Uint8Array {
  if (bitLength > reader.remainingBits) {
    throw new McoImageV4InvalidPayloadError('Unexpected end of v4 bits');
  }
  const bytes = new Uint8Array((bitLength + 7) >> 3);
  for (let index = 0; index < bitLength; index++) {
    if (reader.readBits(1) !== 0) {
      bytes[index >> 3] |= 1 << (7 - (index & 7));
    }
  }
  return bytes;
}

/** Codec 2599-2655. Charges the decoded code points; MCOtxt output is bounded by the payload. */
export function readText(
  reader: V4BitReader,
  style: V4Style,
  currentTextAlign: V4TextAlign,
  currentTextFontSize: number,
  d: V4Dims,
  budget: V4DecodeBudget,
): TextFigure {
  const origin = readPoint(reader, d.width, d.height, d.xBits, d.yBits);
  const mask = reader.readBits(TEXT_MASK_BITS);
  const areaWidth = (mask & 0x01) !== 0 ? reader.readBits(d.xBits) + 1 : null;
  let align = currentTextAlign;
  if ((mask & 0x02) !== 0) {
    const raw = reader.readBits(TEXT_ALIGN_BITS);
    if (raw >= ALIGNS.length) {
      throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 text alignment');
    }
    align = ALIGNS[raw];
  }
  let fontSize = currentTextFontSize;
  if ((mask & 0x04) !== 0) {
    fontSize = reader.readBits(d.scalarBits) + 1;
  }
  const bitLength = reader.readCompactUint();
  const bits = readMcotxtBits(reader, bitLength);
  let decoded: McotxtDecodeResult;
  try {
    decoded = decodeMcotxtStream(bits, bitLength);
  } catch (error) {
    if (error instanceof McotxtCodecError) {
      // A codec version, model generation or language this build has no tables for is a
      // missing feature, not damage.
      if (MCOTXT_UNSUPPORTED_CODES.has(error.code)) {
        throw new McoImageV4UnsupportedFormatError(`MCOtxt: ${error.message}`);
      }
      throw new McoImageV4InvalidPayloadError(`MCOtxt: ${error.message}`);
    }
    throw error;
  }
  let codePoints = 0;
  for (const _ of decoded.text) codePoints++;
  budget.charge({ figures: 1, textCodePoints: codePoints });
  return { kind: 'text', origin, width: areaWidth, fontSize, align, text: decoded.text, style };
}
