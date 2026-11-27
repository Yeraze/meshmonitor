/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: RASTER_LAYER command.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 2657-2695
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
import { decodeV3BodyWithoutNonce } from '../v3/decoder.js';
import { McoImageV3CodecError } from '../v3/errors.js';
import { v3ToRgba } from '../v3/rgba.js';
import type { PaletteProfileId } from '../v3/constants.js';
import type { V4BitReader } from './bitReader.js';
import type { V4DecodeBudget } from './budget.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import type { V4Figure } from './model.js';
import { readPoint } from './primitives.js';
import type { V4Dims } from './primitives.js';

type RasterFigure = Extract<V4Figure, { kind: 'raster' }>;

/**
 * Codec 2657-2695. The layer count is charged before the v3 body is decoded; the pixel
 * count as soon as the dimensions are known and before the RGBA copy is built.
 */
export function readRasterLayer(
  reader: V4BitReader,
  profile: PaletteProfileId,
  d: V4Dims,
  budget: V4DecodeBudget,
): RasterFigure {
  const origin = readPoint(reader, d.width, d.height, d.xBits, d.yBits);
  const v3HeaderHigh = reader.readBits(4);
  const payloadLength = reader.readCompactUint();
  if (payloadLength < 2) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 raster layer payload too short');
  }
  const payload = reader.readBytes(payloadLength);
  budget.charge({ figures: 1, rasterLayers: 1 });
  const body = new Uint8Array(payload.length + 1);
  body[0] = (v3HeaderHigh << 4) | profile;
  body.set(payload, 1);
  let image;
  try {
    image = decodeV3BodyWithoutNonce(body);
  } catch (error) {
    if (error instanceof McoImageV3CodecError) throw new McoImageV4InvalidPayloadError(error.message);
    throw error;
  }
  if (image.paletteProfile !== profile) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 raster layer palette profile mismatch');
  }
  budget.charge({ rasterPixels: image.width * image.height });
  return {
    kind: 'raster',
    x: origin.x,
    y: origin.y,
    width: image.width,
    height: image.height,
    pixels: image.pixels,
    transparentColor: image.transparentColor,
    rgba: v3ToRgba(image),
  };
}
