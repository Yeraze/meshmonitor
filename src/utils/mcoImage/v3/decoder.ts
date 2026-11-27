/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 1766-1864, 5403-5432 and 5450-5531 (bounds, regions, solid rects, preamble, decode)
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
import { CONTAINER_CONTEXT_CONTAINER_SHIFT, CONTAINER_CONTEXT_MASK, HYBRID_COMMON_REGION_ALGORITHM_MARKER, IMPLICIT_WHITE_BACKGROUND_FLAG, MAX_REGIONS, McoImageV3Container, PROFILE_MASK, ScanMode, SUBTYPE_VERSION, TEXT_PREFIX, TRANSPARENT_FLAG } from './constants.js';
import type { McoImageV3BlockAlgorithmId, PaletteProfileId, ScanModeId } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { profileFromId } from './palettes.js';
import { BitReader } from './bitReader.js';
import { algorithmFromId, canUseCompactBlockHeader, containerFromId, localBits, scanFromHeader, scanFromId, topLevelAlgorithm, validateImplicitWhiteBackground, validateTopLevelScan } from './validate.js';
import { base91Decode } from '../base91.js';
import { readBackgroundRef, readColorRef, readDimensions, readSolidBackgroundColor } from './readers.js';
import { readLocalPalette } from './localPalette.js';
import type { RegionGeometry } from './blockBodies.js';
import { decodeBlockBody, decodeBlockBodyWithSharedPalette, fromScanOrder, readDeltaRegionGeometry, readRegionGeometry } from './blockBodies.js';

export function decodeBoundsBlockBody(
  reader: BitReader,
  width: number,
  height: number,
  profile: PaletteProfileId,
  algorithm: McoImageV3BlockAlgorithmId,
  scan: ScanModeId,
  compactGeometry: boolean,
  implicitWhiteBackground: boolean,
) {
  const background = readBackgroundRef(reader, profile, implicitWhiteBackground);
  const bounds = readRegionGeometry(reader, width, height, compactGeometry);
  const croppedLinear = decodeBlockBody(
    reader, bounds.width, bounds.height, profile, algorithm, scan,
    implicitWhiteBackground, background,
  );
  const cropped = fromScanOrder(croppedLinear, bounds.width, bounds.height, scan);
  const pixels = new Array<number>(width * height).fill(background);
  for (let row = 0; row < bounds.height; row++) {
    const srcStart = row * bounds.width;
    const dstStart = (bounds.y + row) * width + bounds.x;
    for (let col = 0; col < bounds.width; col++) pixels[dstStart + col] = cropped[srcStart + col];
  }
  return pixels;
}

export function decodeRegionsBody(
  reader: BitReader,
  width: number,
  height: number,
  profile: PaletteProfileId,
  regionCountContext: number,
  compactGeometry: boolean,
  implicitWhiteBackground: boolean,
) {
  const background = readBackgroundRef(reader, profile, implicitWhiteBackground);
  const regionCount = regionCountContext + 1;
  if (regionCount > MAX_REGIONS) throw new McoImageV3InvalidPayloadError('Invalid v3 region count');
  const hasCommonBlockHeader = compactGeometry && reader.readBits(1) !== 0;
  const hasDeltaGeometry = compactGeometry && reader.readBits(1) !== 0;
  const hasSharedLocalPalette = compactGeometry && reader.readBits(1) !== 0;
  let hasHybridCommonHeader = false;
  let commonAlgorithm: McoImageV3BlockAlgorithmId | null = null;
  let commonScan: ScanModeId | null = null;
  if (hasCommonBlockHeader) {
    const commonAlgorithmId = reader.readBits(5);
    hasHybridCommonHeader = commonAlgorithmId === HYBRID_COMMON_REGION_ALGORITHM_MARKER;
    commonAlgorithm = algorithmFromId(hasHybridCommonHeader ? reader.readBits(5) : commonAlgorithmId);
    commonScan = canUseCompactBlockHeader(commonAlgorithm) ? ScanMode.h : scanFromId(reader.readBits(2));
  }
  const sharedLocalPalette = hasSharedLocalPalette ? readLocalPalette(reader, profile) : null;
  const pixels = new Array<number>(width * height).fill(background);
  let previousBounds: RegionGeometry | null = null;
  for (let i = 0; i < regionCount; i++) {
    const bounds: RegionGeometry = hasDeltaGeometry && i > 0 && previousBounds !== null
      ? readDeltaRegionGeometry(reader, previousBounds, width, height)
      : readRegionGeometry(reader, width, height, compactGeometry);
    previousBounds = bounds;
    const hasIndividualHeader = hasHybridCommonHeader ? reader.readBits(1) !== 0 : !hasCommonBlockHeader;
    const algorithm = hasIndividualHeader ? algorithmFromId(reader.readBits(5)) : commonAlgorithm;
    if (algorithm === null) {
      // Unreachable: without an individual header the common header was read above.
      throw new McoImageV3InvalidPayloadError('Missing common region header');
    }
    const scan = hasIndividualHeader
      ? (canUseCompactBlockHeader(algorithm) ? ScanMode.h : scanFromId(reader.readBits(2)))
      : commonScan;
    if (scan === null) {
      throw new McoImageV3InvalidPayloadError('Missing common region header');
    }
    const linear = sharedLocalPalette == null
      ? decodeBlockBody(
        reader, bounds.width, bounds.height, profile, algorithm, scan,
        implicitWhiteBackground, background,
      )
      : decodeBlockBodyWithSharedPalette(
        reader, bounds.width, bounds.height, algorithm, scan,
        sharedLocalPalette, background,
      );
    const regionPixels = fromScanOrder(linear, bounds.width, bounds.height, scan);
    for (let row = 0; row < bounds.height; row++) {
      const srcStart = row * bounds.width;
      const dstStart = (bounds.y + row) * width + bounds.x;
      for (let col = 0; col < bounds.width; col++) pixels[dstStart + col] = regionPixels[srcStart + col];
    }
  }
  return pixels;
}

export function decodeSolidRectsBody(
  reader: BitReader,
  width: number,
  height: number,
  profile: PaletteProfileId,
  rectCountContext: number,
  implicitWhiteBackground: boolean,
) {
  const background = readBackgroundRef(reader, profile, implicitWhiteBackground);
  const palette = readLocalPalette(reader, profile);
  const bits = localBits(palette.length);
  const rectCount = rectCountContext + (reader.readBits(1) << 5) + 1;
  if (rectCount > 64) throw new McoImageV3InvalidPayloadError('Invalid solid rect count');
  const pixels = new Array<number>(width * height).fill(background);
  for (let i = 0; i < rectCount; i++) {
    const bounds = readRegionGeometry(reader, width, height, true);
    const colorIndex = reader.readBits(bits);
    if (colorIndex >= palette.length) {
      throw new McoImageV3InvalidPayloadError('Solid rect color index out of range');
    }
    for (let row = 0; row < bounds.height; row++) {
      const start = (bounds.y + row) * width + bounds.x;
      for (let col = 0; col < bounds.width; col++) pixels[start + col] = palette[colorIndex];
    }
  }
  return pixels;
}

export function parseBodyPreamble(bodyLike: Uint8Array) {
  const body = bodyLike;
  if (body.length < 4) throw new McoImageV3InvalidPayloadError('MCOimg v3 payload too short');
  const packetNonce = body[0];
  const header = body[1];
  const scan = scanFromHeader(header);
  const hasTransparentColor = (header & TRANSPARENT_FLAG) !== 0;
  const implicitWhiteBackground = (header & IMPLICIT_WHITE_BACKGROUND_FLAG) !== 0;
  const profile = profileFromId(header & PROFILE_MASK);
  const reader = new BitReader(body, 2);
  const dimensions = readDimensions(reader);
  const containerByte = reader.readBits(8);
  const container = containerFromId(containerByte >> CONTAINER_CONTEXT_CONTAINER_SHIFT);
  const containerContext = containerByte & CONTAINER_CONTEXT_MASK;
  const algorithm = topLevelAlgorithm(container, containerContext);
  if (container === McoImageV3Container.block && canUseCompactBlockHeader(algorithm)) {
    throw new McoImageV3InvalidPayloadError('Scan-independent v3 block must use compactBlock');
  }
  if (container === McoImageV3Container.compactBlock && !canUseCompactBlockHeader(algorithm)) {
    throw new McoImageV3InvalidPayloadError('compactBlock cannot be used with scan-dependent algorithms');
  }
  validateTopLevelScan(container, algorithm, scan);
  validateImplicitWhiteBackground(container, algorithm, implicitWhiteBackground);
  return {
    body, packetNonce, header, scan, hasTransparentColor,
    implicitWhiteBackground, profile, reader,
    width: dimensions.width, height: dimensions.height,
    container, containerContext, algorithm,
  };
}

export interface McoImageV3 {
  readonly width: number;
  readonly height: number;
  readonly paletteProfile: PaletteProfileId;
  /** Fixed profiles: palette index. Dynamic profiles: Dynamic Global 512 index. */
  readonly pixels: readonly number[];
  readonly transparentColor: number | null;
}

/**
 * Upstream MCOImageV3Codec.decodeBody (lines 5462-5520). body[0] is the packet nonce
 * (never interpreted). Throws McoImageV3InvalidPayloadError.
 */
export function decodeV3Body(body: Uint8Array): McoImageV3 {
  const preamble = parseBodyPreamble(body);
  const {
    reader, width, height, profile, scan, container, containerContext,
    algorithm, hasTransparentColor, implicitWhiteBackground,
  } = preamble;
  const transparentColor = hasTransparentColor ? readColorRef(reader, profile) : null;
  let pixels: number[];
  switch (container) {
    case McoImageV3Container.block:
      pixels = fromScanOrder(
        decodeBlockBody(reader, width, height, profile, algorithm, scan, implicitWhiteBackground),
        width, height, scan,
      );
      break;
    case McoImageV3Container.compactBlock:
      pixels = fromScanOrder(
        decodeBlockBody(reader, width, height, profile, algorithm, ScanMode.h, implicitWhiteBackground),
        width, height, ScanMode.h,
      );
      break;
    case McoImageV3Container.boundsBlock:
      pixels = decodeBoundsBlockBody(
        reader, width, height, profile, algorithm, scan, false, implicitWhiteBackground,
      );
      break;
    case McoImageV3Container.compactBoundsBlock:
      pixels = decodeBoundsBlockBody(
        reader, width, height, profile, algorithm, scan, true, implicitWhiteBackground,
      );
      break;
    case McoImageV3Container.regions:
      pixels = decodeRegionsBody(
        reader, width, height, profile, containerContext, false, implicitWhiteBackground,
      );
      break;
    case McoImageV3Container.compactRegionsStream:
      pixels = decodeRegionsBody(
        reader, width, height, profile, containerContext, true, implicitWhiteBackground,
      );
      break;
    case McoImageV3Container.solidBackground:
      pixels = new Array<number>(width * height).fill(
        readSolidBackgroundColor(reader, profile, containerContext, implicitWhiteBackground),
      );
      break;
    case McoImageV3Container.solidRects:
      pixels = decodeSolidRectsBody(
        reader, width, height, profile, containerContext, implicitWhiteBackground,
      );
      break;
    default:
      throw new McoImageV3InvalidPayloadError('Unknown MCOimg v3 container');
  }
  reader.finish();
  return { width, height, paletteProfile: profile, pixels, transparentColor };
}

/**
 * Phase 2 IM4 raster layers: body without its nonce (first byte = rebuilt v3 header).
 * Prepends a zero nonce and calls decodeV3Body.
 */
export function decodeV3BodyWithoutNonce(bodyWithoutNonce: Uint8Array): McoImageV3 {
  const body = new Uint8Array(bodyWithoutNonce.length + 1);
  body.set(bodyWithoutNonce, 1);
  return decodeV3Body(body);
}

/** 0x13 | body. Upstream decodeAppPayloadWithoutSender (lines 5522-5531). */
export function decodeV3AppPayload(payload: Uint8Array): McoImageV3 {
  if (payload.length < 2 || payload[0] !== SUBTYPE_VERSION) {
    const actual = payload.length === 0 ? 'empty' : `0x${payload[0].toString(16).padStart(2, '0')}`;
    throw new McoImageV3InvalidPayloadError(
      `Unsupported MCOimg app subtype/version ${actual}`,
    );
  }
  return decodeV3Body(payload.subarray(1));
}

/** 'im3:' + Base91(0x13 | body). Upstream decodeText / appPayloadWithoutSenderFromText (5450, 5596-5601). */
export function decodeV3Text(text: string): McoImageV3 {
  if (typeof text !== 'string' || !text.startsWith(TEXT_PREFIX)) {
    throw new McoImageV3InvalidPayloadError('Missing im3: prefix');
  }
  return decodeV3AppPayload(base91Decode(text.slice(TEXT_PREFIX.length)));
}
