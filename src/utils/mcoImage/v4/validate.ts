/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: figure validation.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 2997-3142
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
import { PaletteProfileName } from '../v3/constants.js';
import type { PaletteProfileId } from '../v3/constants.js';
import { DynamicGlobalIndices, isDynamicProfile, paletteSize } from '../v3/palettes.js';
import { McoImageV4InvalidPayloadError } from './errors.js';
import type { V4Figure, V4Point, V4Style } from './model.js';
import { isCoordinateInRange } from './primitives.js';

// Upstream throws MCOImageInvalidInputException here and decodeBody converts it to an
// invalid-payload error with the same message, so these throw the final class directly.

export function validatePaletteRef(value: number | null, paletteLength: number, label: string): void {
  if (value !== null && (value < 0 || value >= paletteLength)) {
    throw new McoImageV4InvalidPayloadError(`Invalid v4 ${label} palette index`);
  }
}

export function validateStyle(style: V4Style, paletteLength: number, scalarSize: number): void {
  validatePaletteRef(style.fill, paletteLength, 'fill');
  validatePaletteRef(style.stroke, paletteLength, 'stroke');
  if (style.strokeWidth < 1 || style.strokeWidth > scalarSize) {
    throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 stroke width');
  }
}

/** Codec 3554-3573 (_colorRefForProfile), as a range check. */
function checkProfileColor(profile: PaletteProfileId, color: number): void {
  if (!isDynamicProfile(profile)) {
    if (color < 0 || color >= paletteSize(profile)) {
      throw new McoImageV4InvalidPayloadError(
        `Color ${color} is outside fixed profile PaletteProfile.${PaletteProfileName[profile]}`,
      );
    }
    return;
  }
  if (!DynamicGlobalIndices[profile].includes(color)) {
    throw new McoImageV4InvalidPayloadError(
      `Color ${color} is outside dynamic profile PaletteProfile.${PaletteProfileName[profile]}`,
    );
  }
}

const samePoint = (a: V4Point, b: V4Point): boolean => a.x === b.x && a.y === b.y;

/** Codec 2997-3118. Raster pixels come from the v3 decoder, which already bounds them. */
export function validateFigure(
  figure: V4Figure,
  canvasWidth: number,
  canvasHeight: number,
  profile: PaletteProfileId,
  paletteLength: number,
): void {
  const scalarSize = Math.max(canvasWidth, canvasHeight);
  if (figure.kind !== 'raster') validateStyle(figure.style, paletteLength, scalarSize);
  const point = (value: V4Point): void => {
    if (!isCoordinateInRange(value.x, canvasWidth) || !isCoordinateInRange(value.y, canvasHeight)) {
      throw new McoImageV4InvalidPayloadError('MCOimg v4 point is outside the coordinate range');
    }
  };
  switch (figure.kind) {
    case 'dot':
      point(figure.point);
      if (figure.style.stroke === null) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 dot requires a stroke color');
      }
      break;
    case 'line':
      point(figure.start);
      point(figure.end);
      break;
    case 'rect':
    case 'ellipse':
      point(figure.first);
      point(figure.second);
      point(figure.third);
      if (
        samePoint(figure.first, figure.second) ||
        samePoint(figure.first, figure.third) ||
        samePoint(figure.second, figure.third)
      ) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 area figure has duplicate control points');
      }
      break;
    case 'path':
      if (figure.points.length < (figure.closed ? 3 : 2)) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 path has too few points');
      }
      for (const value of figure.points) point(value);
      break;
    case 'wave':
      point(figure.start);
      point(figure.end);
      if (figure.depth === 0 || Math.abs(figure.depth) > scalarSize) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 wave depth');
      }
      break;
    case 'text':
      point(figure.origin);
      if (figure.width !== null && (figure.width < 1 || figure.width > canvasWidth)) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 text area width');
      }
      if (figure.fontSize < 1 || figure.fontSize > scalarSize) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 text font size');
      }
      break;
    case 'raster':
      point({ x: figure.x, y: figure.y });
      if (figure.width < 1 || figure.width > 256 || figure.height < 1 || figure.height > 256) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 raster layer size');
      }
      if (figure.pixels.length !== figure.width * figure.height) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 raster layer pixels');
      }
      if (figure.transparentColor !== null) checkProfileColor(profile, figure.transparentColor);
      break;
    case 'group':
      if (figure.figures.length === 0) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 group is empty');
      }
      for (const child of figure.figures) {
        if (child.kind === 'raster') {
          throw new McoImageV4InvalidPayloadError('MCOimg v4 raster layer cannot be nested in a group');
        }
        validateFigure(child, canvasWidth, canvasHeight, profile, paletteLength);
      }
      break;
  }
}
