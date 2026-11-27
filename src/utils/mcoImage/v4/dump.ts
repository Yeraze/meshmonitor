import { PaletteProfileName } from '../v3/constants.js';
import type { DecodedV4Body } from './decoder.js';
import type { V4Figure, V4Point, V4Style } from './model.js';
import { textDefaultWidth } from './model.js';

/**
 * Test support, never imported by decode.ts. Prints the same JSON shape as the reference
 * generator's dumpDecoded (gen3/lib/helpers/dumplib.dart): colours as palette VALUES.
 */
export interface V4DumpStyle {
  fill: number | null;
  stroke: number | null;
  strokeWidth: number;
}
export type V4DumpFigure = Record<string, unknown>;
export interface V4Dump {
  mode: string;
  width: number;
  height: number;
  paletteProfile: string;
  palette: number[];
  background: number | null;
  nonce: number;
  targetName: string | null;
  replyTimestamp: number | null;
  canonicalDocumentHex: string;
  figures: V4DumpFigure[];
}

const pt = (p: V4Point): { x: number; y: number } => ({ x: p.x, y: p.y });

function st(s: V4Style, pal: readonly number[]): V4DumpStyle {
  return {
    fill: s.fill === null ? null : pal[s.fill],
    stroke: s.stroke === null ? null : pal[s.stroke],
    strokeWidth: s.strokeWidth,
  };
}

function fig(f: V4Figure, pal: readonly number[], canvasWidth: number): V4DumpFigure {
  switch (f.kind) {
    case 'dot':
      return { kind: 'dot', point: pt(f.point), style: st(f.style, pal) };
    case 'line':
      return { kind: 'line', start: pt(f.start), end: pt(f.end), style: st(f.style, pal) };
    case 'rect':
    case 'ellipse':
      return { kind: f.kind, first: pt(f.first), second: pt(f.second), third: pt(f.third), style: st(f.style, pal) };
    case 'path':
      return { kind: 'path', closed: f.closed, points: f.points.map(pt), style: st(f.style, pal) };
    case 'wave':
      return { kind: 'wave', start: pt(f.start), end: pt(f.end), depth: f.depth, closed: f.closed, style: st(f.style, pal) };
    case 'text':
      return {
        kind: 'text',
        origin: pt(f.origin),
        width: f.width,
        resolvedWidth: f.width ?? textDefaultWidth(canvasWidth, f.origin.x),
        fontSize: f.fontSize,
        align: f.align,
        text: f.text,
        style: st(f.style, pal),
      };
    case 'raster':
      return {
        kind: 'raster',
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        transparentColor: f.transparentColor,
        pixels: [...f.pixels],
      };
    case 'group':
      return { kind: 'group', style: st(f.style, pal), figures: f.figures.map((c) => fig(c, pal, canvasWidth)) };
  }
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function dumpV4(decoded: DecodedV4Body): V4Dump {
  const doc = decoded.document;
  return {
    mode: doc.mode,
    width: doc.width,
    height: doc.height,
    paletteProfile: PaletteProfileName[doc.paletteProfile],
    palette: [...doc.palette],
    background: doc.background === null ? null : doc.palette[doc.background],
    nonce: decoded.nonce,
    targetName: decoded.targetName,
    replyTimestamp: decoded.replyTimestamp,
    canonicalDocumentHex: hex(decoded.canonicalDocument),
    figures: doc.figures.map((f) => fig(f, doc.palette, doc.width)),
  };
}
