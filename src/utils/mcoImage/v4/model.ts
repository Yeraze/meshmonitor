/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: document model.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_model.dart, lines 1-490 (model.dart is its name in the upstream mirror); the editor-only 'visible' flag is dropped
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
import type { PaletteProfileId } from '../v3/constants.js';

export interface V4Point {
  readonly x: number;
  readonly y: number;
}

/** Local palette indices (into McoImageV4Document.palette); null = none. */
export interface V4Style {
  readonly fill: number | null;
  readonly stroke: number | null;
  readonly strokeWidth: number;
}

export type V4TextAlign = 'left' | 'center' | 'right';

export type V4Figure =
  | { readonly kind: 'dot'; readonly point: V4Point; readonly style: V4Style }
  | { readonly kind: 'line'; readonly start: V4Point; readonly end: V4Point; readonly style: V4Style }
  | { readonly kind: 'rect'; readonly first: V4Point; readonly second: V4Point; readonly third: V4Point; readonly style: V4Style }
  | { readonly kind: 'ellipse'; readonly first: V4Point; readonly second: V4Point; readonly third: V4Point; readonly style: V4Style }
  | { readonly kind: 'path'; readonly points: readonly V4Point[]; readonly closed: boolean; readonly style: V4Style }
  | { readonly kind: 'wave'; readonly start: V4Point; readonly end: V4Point; readonly depth: number; readonly closed: boolean; readonly style: V4Style }
  | {
      readonly kind: 'text';
      readonly origin: V4Point;
      readonly width: number | null;
      readonly fontSize: number;
      readonly align: V4TextAlign;
      readonly text: string;
      readonly style: V4Style;
    }
  | {
      readonly kind: 'raster';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      /** Profile colour ids (fixed) or Dynamic Global 512 indices. */
      readonly pixels: readonly number[];
      readonly transparentColor: number | null;
      /** RGBA8888, transparent pixels have alpha 0. */
      readonly rgba: Uint8ClampedArray;
    }
  | { readonly kind: 'group'; readonly figures: readonly V4Figure[]; readonly style: V4Style };

export interface McoImageV4Document {
  readonly mode: 'vector' | 'mixed';
  readonly width: number;
  readonly height: number;
  readonly paletteProfile: PaletteProfileId;
  /** Fixed profiles: profile colour id. Dynamic: Dynamic Global 512 index. Order = first use. */
  readonly palette: readonly number[];
  /** Local palette index; null = transparent. */
  readonly background: number | null;
  readonly initialStyle: V4Style;
  readonly figures: readonly V4Figure[];
}

export interface V4FigureWeight {
  readonly figures: number;
  readonly points: number;
  readonly textCodePoints: number;
}

export function sameStyle(a: V4Style, b: V4Style): boolean {
  return a.fill === b.fill && a.stroke === b.stroke && a.strokeWidth === b.strokeWidth;
}

const translatePoint = (p: V4Point, dx: number, dy: number): V4Point => ({ x: p.x + dx, y: p.y + dy });

const weights = new WeakMap<object, V4FigureWeight>();

function codePointCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Cost of materialising one more copy of this figure. A group's weight is cached, so the
 * pre-check before a repeat is O(1).
 */
export function figureWeight(figure: V4Figure): V4FigureWeight {
  const cached = weights.get(figure);
  if (cached) return cached;
  let weight: V4FigureWeight;
  switch (figure.kind) {
    case 'dot':
      weight = { figures: 1, points: 1, textCodePoints: 0 };
      break;
    case 'path':
      weight = { figures: 1, points: figure.points.length, textCodePoints: 0 };
      break;
    case 'text':
      weight = { figures: 1, points: 0, textCodePoints: codePointCount(figure.text) };
      break;
    case 'group': {
      let figures = 1;
      let points = 0;
      let textCodePoints = 0;
      for (const child of figure.figures) {
        const w = figureWeight(child);
        figures += w.figures;
        points += w.points;
        textCodePoints += w.textCodePoints;
      }
      weight = { figures, points, textCodePoints };
      break;
    }
    default:
      weight = { figures: 1, points: 0, textCodePoints: 0 };
  }
  weights.set(figure, weight);
  return weight;
}

/** model.dart translated(): a copy moved by (dx, dy). Raster layers keep their pixels. */
export function translated(figure: V4Figure, dx: number, dy: number): V4Figure {
  switch (figure.kind) {
    case 'dot':
      return { ...figure, point: translatePoint(figure.point, dx, dy) };
    case 'line':
      return { ...figure, start: translatePoint(figure.start, dx, dy), end: translatePoint(figure.end, dx, dy) };
    case 'rect':
    case 'ellipse':
      return {
        ...figure,
        first: translatePoint(figure.first, dx, dy),
        second: translatePoint(figure.second, dx, dy),
        third: translatePoint(figure.third, dx, dy),
      };
    case 'path':
      return { ...figure, points: figure.points.map((p) => translatePoint(p, dx, dy)) };
    case 'wave':
      return { ...figure, start: translatePoint(figure.start, dx, dy), end: translatePoint(figure.end, dx, dy) };
    case 'text':
      return { ...figure, origin: translatePoint(figure.origin, dx, dy) };
    case 'raster':
      return { ...figure, x: figure.x + dx, y: figure.y + dy };
    case 'group':
      return { ...figure, figures: figure.figures.map((child) => translated(child, dx, dy)) };
  }
}

/**
 * model.dart withStyle(): a raster layer ignores it; a group restyles its children only when
 * the new style differs from the group's own.
 */
export function withStyle(figure: V4Figure, style: V4Style): V4Figure {
  switch (figure.kind) {
    case 'raster':
      return figure;
    case 'group':
      if (sameStyle(style, figure.style)) return { ...figure, style };
      return { ...figure, figures: figure.figures.map((child) => withStyle(child, style)), style };
    default:
      return { ...figure, style };
  }
}

/** MCOImageV4Text.defaultWidthFor (model.dart 343-348). */
export const textDefaultWidth = (canvasWidth: number, originX: number): number =>
  Math.max(1, Math.min(canvasWidth, canvasWidth - originX));

/** MCOImageV4Text.defaultFontSizeFor (model.dart 352-354). */
export const textDefaultFontSize = (canvasWidth: number): number =>
  Math.max(1, Math.floor((canvasWidth * 12) / 100));
