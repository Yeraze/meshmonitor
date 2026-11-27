/**
 * IM4 painter: draws a decoded document on a canvas 2D context.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/widgets/mco_image_v4_view.dart, lines 129-197 and 281-688 (MCOImageV4Painter, drawing parts only)
 *
 * Drawing calls mirror the upstream painter; text is laid out by MeshMonitor
 * code (see textLayout.ts), because a canvas has no paragraph engine.
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

import { paletteRgb } from '../v3/palettes.js';
import type { McoImageV4Document, V4Figure, V4Point, V4Style } from './model.js';
import { layoutV4Text, lineBoxCells, V4_TEXT_CAP_HEIGHT_EM } from './textLayout.js';

export type McoPaintContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'translate'
  | 'scale'
  | 'rotate'
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'ellipse'
  | 'arc'
  | 'rect'
  | 'clip'
  | 'fill'
  | 'stroke'
  | 'fillRect'
  | 'clearRect'
  | 'fillText'
  | 'measureText'
  | 'drawImage'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'font'
  | 'textBaseline'
  | 'textAlign'
  | 'imageSmoothingEnabled'
>;

export interface McoPaintOptions {
  /** Backing-store size in device pixels. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** Page font, e.g. getComputedStyle(canvas).fontFamily. */
  readonly fontFamily: string;
  /** Raster layer to drawable; the default builds a canvas element. */
  readonly createLayerSource?: (
    rgba: Uint8ClampedArray,
    w: number,
    h: number,
  ) => CanvasImageSource | null;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

interface View {
  readonly ctx: McoPaintContext;
  readonly doc: McoImageV4Document;
  readonly opts: McoPaintOptions;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

const TWO_PI = Math.PI * 2;

const cell = (p: V4Point): Pt => ({ x: p.x + 0.5, y: p.y + 0.5 });

function hex(view: View, localIndex: number): string {
  const rgb = paletteRgb(view.doc.paletteProfile, view.doc.palette[localIndex]);
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

function defaultLayerSource(rgba: Uint8ClampedArray, w: number, h: number): CanvasImageSource | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  if (!c) return null;
  const data = c.createImageData(w, h);
  data.data.set(rgba);
  c.putImageData(data, 0, 0);
  return canvas;
}

/** Fill (always closed) then stroke (closed only when asked), as the upstream _drawPath. */
function drawPath(view: View, build: () => void, style: V4Style, closedStroke: boolean): void {
  const { ctx } = view;
  if (style.fill !== null) {
    ctx.beginPath();
    build();
    ctx.closePath();
    ctx.fillStyle = hex(view, style.fill);
    ctx.fill('nonzero');
  }
  if (style.stroke !== null) {
    ctx.beginPath();
    build();
    if (closedStroke) ctx.closePath();
    ctx.strokeStyle = hex(view, style.stroke);
    ctx.lineWidth = style.strokeWidth;
    ctx.stroke();
  }
}

function polyline(view: View, pts: readonly Pt[]): () => void {
  return () => {
    pts.forEach((p, i) => (i === 0 ? view.ctx.moveTo(p.x, p.y) : view.ctx.lineTo(p.x, p.y)));
  };
}

function drawEllipse(
  view: View,
  first: V4Point,
  second: V4Point,
  third: V4Point,
  style: V4Style,
): void {
  const a = cell(first);
  const b = cell(second);
  const c = cell(third);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const semiMinor = Math.abs((c.x - cx) * (-dy / length) + (c.y - cy) * (dx / length));
  if (semiMinor < 0.5) {
    drawPath(view, polyline(view, [a, b]), style, false);
    return;
  }
  const semiMajor = length / 2;
  const angle = Math.atan2(dy, dx);
  drawPath(view, () => view.ctx.ellipse(cx, cy, semiMajor, semiMinor, angle, 0, TWO_PI), style, true);
}

function drawText(view: View, figure: Extract<V4Figure, { kind: 'text' }>): void {
  const { ctx, doc, scale, offsetX, offsetY } = view;
  const { fill, stroke } = figure.style;
  if (stroke === null && fill === null) return;
  const origin = cell(figure.origin);
  const areaWidth = figure.width ?? Math.max(1, Math.min(doc.width, doc.width - figure.origin.x));
  const lineBox = lineBoxCells(figure.fontSize);
  // Device pixels: no transform, so no browser min-font-size or hinting quirk touches small text.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${figure.fontSize * scale}px ${view.opts.fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const lines = layoutV4Text(figure.text, areaWidth, figure.align, (s) => ctx.measureText(s).width / scale);
  if (fill !== null) {
    ctx.fillStyle = hex(view, fill);
    ctx.fillRect(
      offsetX + origin.x * scale,
      offsetY + origin.y * scale,
      areaWidth * scale,
      lines.length * lineBox * scale,
    );
  }
  if (stroke !== null) {
    const ascent = ctx.measureText('H').actualBoundingBoxAscent;
    const capCells = Number.isFinite(ascent) ? ascent / scale : V4_TEXT_CAP_HEIGHT_EM * figure.fontSize;
    ctx.fillStyle = hex(view, stroke);
    lines.forEach((line, i) => {
      if (line.text === '') return;
      const baseline = origin.y + i * lineBox + (lineBox + capCells) / 2;
      ctx.fillText(line.text, offsetX + (origin.x + line.x) * scale, offsetY + baseline * scale);
    });
  }
  ctx.restore();
}

function drawFigure(view: View, figure: V4Figure): void {
  const { ctx } = view;
  switch (figure.kind) {
    case 'dot': {
      if (figure.style.stroke === null) return;
      const p = cell(figure.point);
      ctx.beginPath();
      ctx.arc(p.x, p.y, figure.style.strokeWidth / 2, 0, TWO_PI);
      ctx.fillStyle = hex(view, figure.style.stroke);
      ctx.fill('nonzero');
      return;
    }
    case 'line': {
      if (figure.style.stroke === null) return;
      const a = cell(figure.start);
      const b = cell(figure.end);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = hex(view, figure.style.stroke);
      ctx.lineWidth = figure.style.strokeWidth;
      ctx.stroke();
      return;
    }
    case 'rect': {
      const a = cell(figure.first);
      const b = cell(figure.third);
      const c = cell(figure.second);
      const d = { x: a.x + c.x - b.x, y: a.y + c.y - b.y };
      drawPath(view, polyline(view, [a, b, c, d]), figure.style, true);
      return;
    }
    case 'ellipse':
      drawEllipse(view, figure.first, figure.second, figure.third, figure.style);
      return;
    case 'path':
      drawPath(view, polyline(view, figure.points.map(cell)), figure.style, figure.closed);
      return;
    case 'wave': {
      const a = cell(figure.start);
      const b = cell(figure.end);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      if (length === 0) return;
      const cx = (a.x + b.x) / 2 + (-dy / length) * figure.depth * 2;
      const cy = (a.y + b.y) / 2 + (dx / length) * figure.depth * 2;
      drawPath(
        view,
        () => {
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        },
        figure.style,
        figure.closed,
      );
      return;
    }
    case 'text':
      drawText(view, figure);
      return;
    case 'raster': {
      const make = view.opts.createLayerSource ?? defaultLayerSource;
      const source = make(figure.rgba, figure.width, figure.height);
      if (!source) return;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(source, figure.x, figure.y, figure.width, figure.height);
      ctx.restore();
      return;
    }
    case 'group':
      for (const child of figure.figures) drawFigure(view, child);
  }
}

/**
 * Draws the document fitted and centred in the backing store. Geometry is
 * never rewritten; a point (x, y) is the centre of cell (x, y).
 */
export function paintMcoImageV4(
  ctx: McoPaintContext,
  doc: McoImageV4Document,
  opts: McoPaintOptions,
): void {
  const scale = Math.min(opts.pixelWidth / doc.width, opts.pixelHeight / doc.height);
  const offsetX = (opts.pixelWidth - doc.width * scale) / 2;
  const offsetY = (opts.pixelHeight - doc.height * scale) / 2;
  const view: View = { ctx, doc, opts, scale, offsetX, offsetY };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, opts.pixelWidth, opts.pixelHeight);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, doc.width, doc.height);
  ctx.clip();
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  if (doc.background !== null) {
    ctx.fillStyle = hex(view, doc.background);
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  for (const figure of doc.figures) drawFigure(view, figure);
  ctx.restore();
}
