/**
 * TypeScript port of the MCOimg v4 (IM4) raster encoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 88-121, 218-221, 239-272 + 424-426, 1053-1112, 3345-3381 (raster-layer-only subset)
 *
 * Only the single-raster-layer document is ported (no vector figures, no transport
 * tail). Logic and check order follow the upstream file; only types were added.
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
import { base91Encode } from '../base91.js';
import type { PaletteProfileId } from '../v3/constants.js';
import { MAX_SIZE, MIN_SIZE } from '../v3/constants.js';
import { V4BitWriter } from './bitWriter.js';
import {
  DIMENSION_MODE_EXTENDED,
  DIMENSION_MODE_MEDIUM64,
  DIMENSION_MODE_SMALL32,
  DIMENSION_MODE_SQUARE64,
  EXT_RASTER_LAYER,
  EXT_BITS,
  Mode,
  MODE_BITS,
  OP_BITS,
  OP_END,
  OP_EXTENDED,
  TEXT_PREFIX_V4,
} from './constants.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import { coordinateBits, coordinateMargin } from './primitives.js';

/** Codec 3345-3381 (_writeDimensions). */
function writeDimensions(writer: V4BitWriter, width: number, height: number): void {
  if (width === height && width <= 64) {
    writer.writeBits(DIMENSION_MODE_SQUARE64, 2);
    writer.writeBits(width - 1, 6);
    return;
  }
  if (width <= 32 && height <= 32) {
    writer.writeBits(DIMENSION_MODE_SMALL32, 2);
    writer.writeBits(width - 1, 5);
    writer.writeBits(height - 1, 5);
    return;
  }
  if (width <= 64 && height <= 64) {
    writer.writeBits(DIMENSION_MODE_MEDIUM64, 2);
    writer.writeBits(width - 1, 6);
    writer.writeBits(height - 1, 6);
    return;
  }
  writer.writeBits(DIMENSION_MODE_EXTENDED, 2);
  if (width === height) {
    writer.writeBit(false);
    writer.writeBits(width - 1, 8);
    return;
  }
  writer.writeBit(true);
  writer.writeBits(width - 1, 8);
  writer.writeBits(height - 1, 8);
}

/**
 * Body of an IM4 document holding one raster layer at (0, 0): `nonce | document` (codec 108-112
 * with an empty transport tail). The document palette is `[white]` and the background is that
 * white, so the background-override bit is 0 (codec 260-272, 3152-3158).
 */
export function im4BodyFromV3Body(args: {
  width: number;
  height: number;
  profile: PaletteProfileId;
  /** v3 body without its nonce: the rebuilt header byte first; its low nibble is the profile. */
  v3BodyWithoutNonce: Uint8Array;
  nonce: number;
}): Uint8Array {
  const { width, height, profile, v3BodyWithoutNonce, nonce } = args;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIZE || height < MIN_SIZE || width > MAX_SIZE || height > MAX_SIZE) {
    throw new McoImageV4InvalidPayloadError('Invalid v4 raster dimensions');
  }
  if (v3BodyWithoutNonce.length < 2) {
    throw new McoImageV4InvalidPayloadError('v3 raster payload too short');
  }
  if ((v3BodyWithoutNonce[0] & 0x0f) !== profile) {
    throw new McoImageV4InvalidPayloadError('v3 payload profile does not match the document profile');
  }
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xff) {
    throw new McoImageV4InvalidPayloadError('Invalid v4 nonce');
  }
  const xBits = coordinateBits(width);
  const yBits = coordinateBits(height);
  const writer = new V4BitWriter();
  writer.writeBits(Mode.mixed, MODE_BITS);
  writer.writeBits(profile, 4);
  writeDimensions(writer, width, height);
  writer.writeBit(false); // background = document white = default
  // _encodeRasterLayerCommand (codec 1053-1086), origin (0, 0).
  writer.writeBits(OP_EXTENDED, OP_BITS);
  writer.writeBits(EXT_RASTER_LAYER, EXT_BITS);
  writer.writeBits(coordinateMargin(width), xBits);
  writer.writeBits(coordinateMargin(height), yBits);
  writer.writeBits(v3BodyWithoutNonce[0] >> 4, 4); // v3HeaderHigh
  const payload = v3BodyWithoutNonce.subarray(1);
  writer.writeCompactUint(payload.length);
  writer.writeBytes(payload);
  writer.writeBits(OP_END, OP_BITS);
  const document = writer.toBytes();
  const body = new Uint8Array(1 + document.length);
  body[0] = nonce;
  body.set(document, 1);
  return body;
}

/** `im4:` + Base91(body) (codec 218-221). */
export function im4TextFromV3Body(args: Parameters<typeof im4BodyFromV3Body>[0]): string {
  return `${TEXT_PREFIX_V4}${base91Encode(im4BodyFromV3Body(args))}`;
}
