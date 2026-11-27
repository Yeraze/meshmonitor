/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 341-480 (geometry, id and validation helpers)
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
import { MAX_SIZE, MIN_SIZE, McoImageV3BlockAlgorithm, McoImageV3BlockAlgorithmName, McoImageV3Container, McoImageV3ContainerName, SCAN_MASK, SCAN_SHIFT, ScanMode, ScanModeName } from './constants.js';
import type { McoImageV3BlockAlgorithmId, McoImageV3ContainerId, ScanModeId } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { bitLength } from './bitReader.js';

export function localBits(colorCount: number) {
  if (colorCount <= 1) return 0;
  return bitLength(colorCount - 1);
}

export function geometryBits(size: number) {
  if (size <= 1) return 0;
  return bitLength(size - 1);
}

export function validateDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < MIN_SIZE || height < MIN_SIZE || width > MAX_SIZE || height > MAX_SIZE) {
    throw new McoImageV3InvalidPayloadError(
      `Image size must be ${MIN_SIZE}..${MAX_SIZE} in both axes`,
    );
  }
}

export function algorithmFromId(value: number): McoImageV3BlockAlgorithmId {
  if (!Number.isInteger(value) || value < 0 || value >= McoImageV3BlockAlgorithmName.length) {
    throw new McoImageV3InvalidPayloadError(`Unknown MCOimg v3 algorithm ${value}`);
  }
  return value as McoImageV3BlockAlgorithmId;
}

export function containerFromId(value: number): McoImageV3ContainerId {
  if (!Number.isInteger(value) || value < 0 || value >= McoImageV3ContainerName.length) {
    throw new McoImageV3InvalidPayloadError(`Unknown MCOimg v3 container ${value}`);
  }
  return value as McoImageV3ContainerId;
}

export function scanFromId(value: number): ScanModeId {
  if (!Number.isInteger(value) || value < 0 || value >= ScanModeName.length) {
    throw new McoImageV3InvalidPayloadError(`Unknown MCOimg v3 scan ${value}`);
  }
  return value as ScanModeId;
}

export function scanFromHeader(header: number): ScanModeId {
  return scanFromId((header & SCAN_MASK) >> SCAN_SHIFT);
}

export function topLevelAlgorithm(container: McoImageV3ContainerId, context: number): McoImageV3BlockAlgorithmId {
  switch (container) {
    case McoImageV3Container.block:
    case McoImageV3Container.compactBlock:
    case McoImageV3Container.boundsBlock:
    case McoImageV3Container.compactBoundsBlock:
      return algorithmFromId(context);
    default:
      return McoImageV3BlockAlgorithm.rawGlobal;
  }
}

export function canUseCompactBlockHeader(algorithm: McoImageV3BlockAlgorithmId) {
  return algorithm === McoImageV3BlockAlgorithm.rawGlobal ||
    algorithm === McoImageV3BlockAlgorithm.rawLocal ||
    algorithm === McoImageV3BlockAlgorithm.biColorMask;
}

export function blockAlgorithmUsesBackgroundRef(algorithm: McoImageV3BlockAlgorithmId) {
  return algorithm === McoImageV3BlockAlgorithm.compactSparse ||
    algorithm === McoImageV3BlockAlgorithm.varUintSparse ||
    algorithm === McoImageV3BlockAlgorithm.biColorMask;
}

export function validateTopLevelScan(container: McoImageV3ContainerId, algorithm: McoImageV3BlockAlgorithmId, scan: ScanModeId) {
  let requiresHorizontal = false;
  switch (container) {
    case McoImageV3Container.compactBlock:
    case McoImageV3Container.regions:
    case McoImageV3Container.compactRegionsStream:
    case McoImageV3Container.solidBackground:
    case McoImageV3Container.solidRects:
      requiresHorizontal = true;
      break;
    case McoImageV3Container.compactBoundsBlock:
      requiresHorizontal = canUseCompactBlockHeader(algorithm);
      break;
  }
  if (requiresHorizontal && scan !== ScanMode.h) {
    throw new McoImageV3InvalidPayloadError(
      `${McoImageV3ContainerName[container]} requires horizontal top-level scan`,
    );
  }
  if (algorithm === McoImageV3BlockAlgorithm.quadtree && scan !== ScanMode.h) {
    throw new McoImageV3InvalidPayloadError('Quadtree requires horizontal scan');
  }
}

export function validateImplicitWhiteBackground(container: McoImageV3ContainerId, algorithm: McoImageV3BlockAlgorithmId, implicitWhiteBackground: boolean) {
  if (!implicitWhiteBackground) return;
  let allowed;
  if (container === McoImageV3Container.block || container === McoImageV3Container.compactBlock) {
    allowed = blockAlgorithmUsesBackgroundRef(algorithm);
  } else {
    allowed = true;
  }
  if (!allowed) {
    throw new McoImageV3InvalidPayloadError(
      'Implicit white background is not valid for this container',
    );
  }
}

export function blockAlgorithmLabel(algorithm: McoImageV3BlockAlgorithmId) {
  switch (algorithm) {
    case McoImageV3BlockAlgorithm.rawGlobal: return 'Raw global';
    case McoImageV3BlockAlgorithm.rawLocal: return 'Raw local';
    case McoImageV3BlockAlgorithm.compactRle: return 'RLE local';
    case McoImageV3BlockAlgorithm.varUintRle: return 'RLE varuint';
    case McoImageV3BlockAlgorithm.compactSparse: return 'Sparse background';
    case McoImageV3BlockAlgorithm.varUintSparse: return 'Sparse varuint';
    case McoImageV3BlockAlgorithm.biColorMask: return 'Bi-color mask';
    case McoImageV3BlockAlgorithm.rowRepeat: return 'Row repeat';
    case McoImageV3BlockAlgorithm.lzPixels: return 'LZ pixels';
    case McoImageV3BlockAlgorithm.quadtree: return 'Quadtree';
    case McoImageV3BlockAlgorithm.bitplanes: return 'Bitplanes';
    case McoImageV3BlockAlgorithm.adaptiveBitplanes: return 'Adaptive bitplanes';
    case McoImageV3BlockAlgorithm.directBitplanes: return 'Direct bitplanes';
    case McoImageV3BlockAlgorithm.compactRowDelta: return 'Compact row delta';
    case McoImageV3BlockAlgorithm.directRowDelta: return 'Direct row delta';
    case McoImageV3BlockAlgorithm.rowDelta: return 'Row delta';
    default: return `Algorithm ${algorithm}`;
  }
}

export function payloadAlgorithmLabel(container: McoImageV3ContainerId, algorithm: McoImageV3BlockAlgorithmId) {
  if (container === McoImageV3Container.solidBackground) return 'Solid background';
  if (container === McoImageV3Container.solidRects) return 'Solid rectangles';
  if (container === McoImageV3Container.regions ||
      container === McoImageV3Container.compactRegionsStream) return 'Regions';
  const base = blockAlgorithmLabel(algorithm);
  if (container === McoImageV3Container.boundsBlock ||
      container === McoImageV3Container.compactBoundsBlock) return `${base} bounds`;
  return base;
}

