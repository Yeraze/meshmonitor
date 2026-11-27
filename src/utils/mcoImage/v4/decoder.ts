/**
 * TypeScript port of the MCOimg v4 (IM4) decoder: document and command decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/helpers/mcoimg_v4_codec.dart, lines 123-184, 222-233, 428-606, 1983-2500
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
import { McoImageV3CodecError } from '../v3/errors.js';
import { base91Decode } from '../base91.js';
import { McotxtCodecError } from '../mcotxt/errors.js';
import { PaletteProfileName } from '../v3/constants.js';
import type { PaletteProfileId } from '../v3/constants.js';
import { profileFromId, whiteIndexFor } from '../v3/palettes.js';
import { V4BitReader, V4ByteReader } from './bitReader.js';
import { V4DecodeBudget } from './budget.js';
import {
  DELTA_WIDTHS,
  EXT2_BITS,
  EXT2_TEXT,
  EXT_AREA_DELTA,
  EXT_BITS,
  EXT_DOT_RUN,
  EXT_ELLIPSE_DEPTH,
  EXT_ESCAPE,
  EXT_GROUP,
  EXT_LINE_AXIS_ABSOLUTE,
  EXT_LINE_AXIS_DELTA,
  EXT_LINE_DELTA,
  EXT_PATH_BOUNDS,
  EXT_PATH_BOUNDS_DELTA,
  EXT_PATH_ORTHOGONAL,
  EXT_RASTER_LAYER,
  EXT_REPEAT_BACK,
  EXT_REPEAT_COLOR_RUN,
  EXT_SET_STYLE,
  EXT_WAVE_DELTA,
  MCO_V4_DEFAULT_LIMITS,
  MODE_BITS,
  Mode,
  OP_BITS,
  OP_DOT,
  OP_ELLIPSE,
  OP_ELLIPSE_AXIS_ALIGNED,
  OP_END,
  OP_EXTENDED,
  OP_LINE,
  OP_PATH_ABSOLUTE,
  OP_PATH_DELTA,
  OP_RECT,
  OP_RECT_AXIS_ALIGNED,
  OP_REPEAT_LAST,
  OP_REPEAT_SHORT,
  OP_SET_FILL,
  OP_SET_STROKE,
  OP_SET_STROKE_WIDTH,
  OP_WAVE,
  TEXT_PREFIX_V4,
} from './constants.js';
import type { McoV4Limits } from './constants.js';
import {
  McoImageV4CodecError,
  McoImageV4InvalidPayloadError,
  McoImageV4UnsupportedFormatError,
} from './errors.js';
import { figureWeight, textDefaultFontSize, translated, withStyle } from './model.js';
import type { McoImageV4Document, V4Figure, V4Point, V4Style, V4TextAlign } from './model.js';
import {
  blackIndexFor,
  colorFromProfileRef,
  coordinateBits,
  ellipseThirdFromDepth,
  profileColorBits,
  readCoordinate,
  readDimensions,
  readPoint,
  scalarBits as scalarBitsFor,
  validatePointInPayload,
  zigZagDecode,
} from './primitives.js';
import type { V4Dims } from './primitives.js';
import {
  readBoundsDeltaPath,
  readBoundsPath,
  readDotRun,
  readOrthogonalPath,
  readPath,
  readPointDeltaSequence,
} from './paths.js';
import { readRasterLayer } from './raster.js';
import { readText } from './text.js';
import { validateFigure } from './validate.js';

export interface DecodedV4Body {
  readonly document: McoImageV4Document;
  readonly canonicalDocument: Uint8Array;
  readonly nonce: number;
  readonly targetName: string | null;
  readonly replyTimestamp: number | null;
}

interface ExtendedReadResult {
  readonly style: V4Style;
  /** Absent when the command left the sticky text state alone (everything except TEXT). */
  readonly textAlign?: V4TextAlign;
  readonly textFontSize?: number;
  readonly figures: readonly V4Figure[];
}

interface ReadContext {
  readonly reader: V4BitReader;
  readonly dims: V4Dims;
  readonly profile: PaletteProfileId;
  readonly budget: V4DecodeBudget;
  /** Optional colour: present bit, then a profile reference, registered in the local palette. */
  readonly optionalColor: () => number | null;
}

const withFill = (style: V4Style, fill: number | null): V4Style => ({ ...style, fill });
const withStroke = (style: V4Style, stroke: number | null): V4Style => ({ ...style, stroke });
const withStrokeWidth = (style: V4Style, strokeWidth: number): V4Style => ({ ...style, strokeWidth });

/** Charge `count` copies of `source` BEFORE any copy is built. */
function chargeCopies(budget: V4DecodeBudget, source: V4Figure, count: number): void {
  const w = figureWeight(source);
  budget.charge({
    figures: w.figures * count,
    points: w.points * count,
    textCodePoints: w.textCodePoints * count,
  });
}

function repeatOf(budget: V4DecodeBudget, source: V4Figure, dx: number, dy: number, style: V4Style): V4Figure {
  chargeCopies(budget, source, 1);
  return withStyle(translated(source, dx, dy), style);
}

/** Codec 123-184. Throws only the three McoImageV4CodecError leaf classes. */
export function decodeV4Body(body: Uint8Array, limits: McoV4Limits = MCO_V4_DEFAULT_LIMITS): DecodedV4Body {
  try {
    if (body.length === 0) {
      throw new McoImageV4InvalidPayloadError('MCOimg v4 payload too short');
    }
    const nonce = body[0];
    const decoded = decodeCanonicalDocumentPrefix(body.subarray(1), new V4DecodeBudget(limits));
    const { document, canonicalDocument } = decoded;
    const reader = new V4ByteReader(body.subarray(1 + canonicalDocument.length));

    let targetName: string | null = null;
    let replyTimestamp: number | null = null;
    if (reader.remaining > 0) {
      const flags = reader.readByte();
      if ((flags & ~0x03) !== 0) {
        throw new McoImageV4InvalidPayloadError('Unknown v4 transport flags');
      }
      if ((flags & 0x01) !== 0) {
        const length = reader.readCanonicalVarUint7();
        if (length <= 0) {
          throw new McoImageV4InvalidPayloadError('Empty v4 target name');
        }
        targetName = new TextDecoder('utf-8', { fatal: true }).decode(reader.readBytes(length));
      }
      if ((flags & 0x02) !== 0) {
        replyTimestamp = reader.readUint32Le();
      }
      if (reader.remaining !== 0) {
        throw new McoImageV4InvalidPayloadError('Trailing v4 transport bytes');
      }
    }
    return { document, canonicalDocument, nonce, targetName, replyTimestamp };
  } catch (error) {
    if (error instanceof McoImageV4CodecError) throw error;
    if (error instanceof McoImageV3CodecError || error instanceof McotxtCodecError) {
      throw new McoImageV4InvalidPayloadError(error.message);
    }
    throw new McoImageV4InvalidPayloadError(`Invalid v4 payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `im4:` + Base91(body), no subtype byte (codec 222-233). */
export function decodeV4Text(text: string, limits: McoV4Limits = MCO_V4_DEFAULT_LIMITS): DecodedV4Body {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(TEXT_PREFIX_V4)) {
    throw new McoImageV4InvalidPayloadError('Not an MCOimg v4 text');
  }
  let body: Uint8Array;
  try {
    body = base91Decode(trimmed.substring(TEXT_PREFIX_V4.length));
  } catch (error) {
    if (error instanceof McoImageV3CodecError) throw new McoImageV4InvalidPayloadError(error.message);
    throw error;
  }
  return decodeV4Body(body, limits);
}

/** Codec 428-436. */
function decodeCanonicalDocumentPrefix(
  bytes: Uint8Array,
  budget: V4DecodeBudget,
): { document: McoImageV4Document; canonicalDocument: Uint8Array } {
  const reader = new V4BitReader(bytes);
  const document = readCanonicalDocument(reader, budget);
  reader.finishByte();
  return { document, canonicalDocument: bytes.subarray(0, reader.byteOffset) };
}

function containsRasterLayer(figures: readonly V4Figure[]): boolean {
  for (const figure of figures) {
    if (figure.kind === 'raster') return true;
    if (figure.kind === 'group' && containsRasterLayer(figure.figures)) return true;
  }
  return false;
}

/** Codec 438-606. */
function readCanonicalDocument(reader: V4BitReader, budget: V4DecodeBudget): McoImageV4Document {
  const modeIndex = reader.readBits(MODE_BITS);
  if (modeIndex !== Mode.vector && modeIndex !== Mode.mixed) {
    throw new McoImageV4UnsupportedFormatError('Unsupported MCOimg v4 mode');
  }
  const mode: 'vector' | 'mixed' = modeIndex === Mode.vector ? 'vector' : 'mixed';
  const profileIndex = reader.readBits(4);
  if (profileIndex >= PaletteProfileName.length) {
    throw new McoImageV4InvalidPayloadError('Invalid v4 palette profile');
  }
  const paletteProfile = profileFromId(profileIndex);
  const { width, height } = readDimensions(reader);
  const colorBits = profileColorBits(paletteProfile);
  const palette: number[] = [];
  const paletteIndexByColor = new Map<number, number>();
  const localColorFromProfileColor = (color: number): number => {
    const existing = paletteIndexByColor.get(color);
    if (existing !== undefined) return existing;
    const index = palette.length;
    palette.push(color);
    paletteIndexByColor.set(color, index);
    return index;
  };
  const localColorFromProfileRef = (): number => {
    const ref = reader.readBits(colorBits);
    return localColorFromProfileColor(colorFromProfileRef(paletteProfile, ref));
  };
  const optionalLocalColorFromProfileRef = (): number | null =>
    reader.readBit() ? localColorFromProfileRef() : null;

  const xBits = coordinateBits(width);
  const yBits = coordinateBits(height);
  const dims: V4Dims = { width, height, xBits, yBits, scalarBits: scalarBitsFor(width, height) };

  const defaultBackground = localColorFromProfileColor(whiteIndexFor(paletteProfile));
  const background = reader.readBit() ? optionalLocalColorFromProfileRef() : defaultBackground;
  let currentStyle: V4Style = {
    fill: null,
    stroke: localColorFromProfileColor(blackIndexFor(paletteProfile)),
    strokeWidth: 1,
  };
  const initialStyle = currentStyle;
  let currentTextAlign: V4TextAlign = 'left';
  let currentTextFontSize = textDefaultFontSize(width);
  const figures: V4Figure[] = [];
  const history: V4Figure[] = [];
  const ctx: ReadContext = { reader, dims, profile: paletteProfile, budget, optionalColor: optionalLocalColorFromProfileRef };

  const addFigure = (figure: V4Figure): void => {
    validateFigure(figure, width, height, paletteProfile, palette.length);
    figures.push(figure);
    if (figure.kind !== 'raster') history.push(figure);
  };

  for (;;) {
    const opcode = reader.readBits(OP_BITS);
    if (opcode === OP_END) break;
    switch (opcode) {
      case OP_SET_FILL:
        currentStyle = withFill(currentStyle, optionalLocalColorFromProfileRef());
        break;
      case OP_SET_STROKE:
        currentStyle = withStroke(currentStyle, optionalLocalColorFromProfileRef());
        break;
      case OP_SET_STROKE_WIDTH:
        currentStyle = withStrokeWidth(currentStyle, reader.readBits(dims.scalarBits) + 1);
        break;
      case OP_REPEAT_LAST: {
        if (history.length === 0) {
          throw new McoImageV4InvalidPayloadError('MCOimg v4 repeat has no previous figure');
        }
        const dx = zigZagDecode(reader.readBits(xBits + 1));
        const dy = zigZagDecode(reader.readBits(yBits + 1));
        addFigure(repeatOf(budget, history[history.length - 1], dx, dy, currentStyle));
        break;
      }
      case OP_REPEAT_SHORT: {
        if (history.length === 0) {
          throw new McoImageV4InvalidPayloadError('MCOimg v4 repeat has no previous figure');
        }
        const shortBits = DELTA_WIDTHS[reader.readBits(2)];
        const dx = zigZagDecode(reader.readBits(shortBits));
        const dy = zigZagDecode(reader.readBits(shortBits));
        addFigure(repeatOf(budget, history[history.length - 1], dx, dy, currentStyle));
        break;
      }
      case OP_EXTENDED: {
        const result = readExtendedCommand(ctx, currentStyle, history, mode === 'mixed', currentTextAlign, currentTextFontSize);
        currentStyle = result.style;
        currentTextAlign = result.textAlign ?? currentTextAlign;
        currentTextFontSize = result.textFontSize ?? currentTextFontSize;
        for (const figure of result.figures) addFigure(figure);
        break;
      }
      default:
        addFigure(readFigure(opcode, ctx, currentStyle));
    }
  }
  if (mode === 'mixed' && !containsRasterLayer(figures)) {
    throw new McoImageV4InvalidPayloadError('MCOimg v4 mixed document has no raster layers');
  }
  return { mode, width, height, paletteProfile, palette, background, initialStyle, figures };
}

/** Codec 1983-2073. */
function readFigure(opcode: number, ctx: ReadContext, style: V4Style): V4Figure {
  const { reader, dims: d, budget } = ctx;
  const point = (): V4Point => readPoint(reader, d.width, d.height, d.xBits, d.yBits);
  switch (opcode) {
    case OP_DOT: {
      const figure: V4Figure = { kind: 'dot', point: point(), style };
      budget.charge({ figures: 1, points: 1 });
      return figure;
    }
    case OP_LINE: {
      const start = point();
      const end = point();
      budget.charge({ figures: 1 });
      return { kind: 'line', start, end, style };
    }
    case OP_RECT:
    case OP_ELLIPSE: {
      const first = point();
      const second = point();
      const third = point();
      budget.charge({ figures: 1 });
      return { kind: opcode === OP_RECT ? 'rect' : 'ellipse', first, second, third, style };
    }
    case OP_RECT_AXIS_ALIGNED:
    case OP_ELLIPSE_AXIS_ALIGNED: {
      const swapped = reader.readBit();
      const first = point();
      const second = point();
      const third: V4Point = swapped ? { x: second.x, y: first.y } : { x: first.x, y: second.y };
      budget.charge({ figures: 1 });
      return { kind: opcode === OP_RECT_AXIS_ALIGNED ? 'rect' : 'ellipse', first, second, third, style };
    }
    case OP_PATH_ABSOLUTE:
    case OP_PATH_DELTA: {
      const path = readPath(opcode, reader, style, d, budget);
      budget.charge({ figures: 1 });
      return path;
    }
    case OP_WAVE: {
      const closed = reader.readBit();
      const start = point();
      const end = point();
      const negative = reader.readBit();
      const magnitude = reader.readBits(d.scalarBits) + 1;
      budget.charge({ figures: 1 });
      return { kind: 'wave', start, end, depth: negative ? -magnitude : magnitude, closed, style };
    }
    default:
      throw new McoImageV4InvalidPayloadError(`Unknown MCOimg v4 opcode: ${opcode}`);
  }
}

/** Reads dx, dy for REPEAT_BACK / REPEAT_COLOR_RUN: short deltas or full-width coordinates. */
function readRepeatDelta(ctx: ReadContext, short: boolean): { dx: number; dy: number } {
  const { reader, dims: d } = ctx;
  if (short) {
    const shortBits = DELTA_WIDTHS[reader.readBits(2)];
    const dx = zigZagDecode(reader.readBits(shortBits));
    const dy = zigZagDecode(reader.readBits(shortBits));
    return { dx, dy };
  }
  const dx = zigZagDecode(reader.readBits(d.xBits + 1));
  const dy = zigZagDecode(reader.readBits(d.yBits + 1));
  return { dx, dy };
}

/** Codec 2075-2500. */
function readExtendedCommand(
  ctx: ReadContext,
  style: V4Style,
  history: V4Figure[],
  allowRasterLayer: boolean,
  textAlign: V4TextAlign,
  textFontSize: number,
): ExtendedReadResult {
  const { reader, dims: d, budget } = ctx;
  const one = (figure: V4Figure): ExtendedReadResult => ({ style, figures: [figure] });
  const point = (): V4Point => readPoint(reader, d.width, d.height, d.xBits, d.yBits);

  const subop = reader.readBits(EXT_BITS);
  switch (subop) {
    case EXT_SET_STYLE: {
      const mask = reader.readBits(3);
      if (mask === 0) {
        throw new McoImageV4InvalidPayloadError('Empty MCOimg v4 style change');
      }
      let next = style;
      if ((mask & 0x01) !== 0) next = withFill(next, ctx.optionalColor());
      if ((mask & 0x02) !== 0) next = withStroke(next, ctx.optionalColor());
      if ((mask & 0x04) !== 0) next = withStrokeWidth(next, reader.readBits(d.scalarBits) + 1);
      return { style: next, figures: [] };
    }
    case EXT_LINE_DELTA: {
      const points = readPointDeltaSequence(reader, 2, d);
      budget.charge({ figures: 1 });
      return one({ kind: 'line', start: points[0], end: points[1], style });
    }
    case EXT_LINE_AXIS_DELTA: {
      const vertical = reader.readBit();
      const shortBits = DELTA_WIDTHS[reader.readBits(2)];
      const start = point();
      const delta = zigZagDecode(reader.readBits(shortBits));
      const end: V4Point = vertical ? { x: start.x, y: start.y + delta } : { x: start.x + delta, y: start.y };
      validatePointInPayload(end, d.width, d.height);
      budget.charge({ figures: 1 });
      return one({ kind: 'line', start, end, style });
    }
    case EXT_LINE_AXIS_ABSOLUTE: {
      const vertical = reader.readBit();
      budget.charge({ figures: 1 });
      if (vertical) {
        const x = readCoordinate(reader, d.xBits, d.width);
        const startY = readCoordinate(reader, d.yBits, d.height);
        const endY = readCoordinate(reader, d.yBits, d.height);
        return one({ kind: 'line', start: { x, y: startY }, end: { x, y: endY }, style });
      }
      const y = readCoordinate(reader, d.yBits, d.height);
      const startX = readCoordinate(reader, d.xBits, d.width);
      const endX = readCoordinate(reader, d.xBits, d.width);
      return one({ kind: 'line', start: { x: startX, y }, end: { x: endX, y }, style });
    }
    case EXT_AREA_DELTA: {
      const isEllipse = reader.readBit();
      const points = readPointDeltaSequence(reader, 3, d);
      budget.charge({ figures: 1 });
      return one({
        kind: isEllipse ? 'ellipse' : 'rect',
        first: points[0],
        second: points[1],
        third: points[2],
        style,
      });
    }
    case EXT_WAVE_DELTA: {
      const closed = reader.readBit();
      const negative = reader.readBit();
      const magnitude = reader.readBits(d.scalarBits) + 1;
      const points = readPointDeltaSequence(reader, 2, d);
      budget.charge({ figures: 1 });
      return one({
        kind: 'wave',
        start: points[0],
        end: points[1],
        depth: negative ? -magnitude : magnitude,
        closed,
        style,
      });
    }
    case EXT_ELLIPSE_DEPTH: {
      const first = point();
      const second = point();
      const negative = reader.readBit();
      const magnitude = reader.readBits(d.scalarBits) + 1;
      const third = ellipseThirdFromDepth(first, second, negative ? -magnitude : magnitude);
      if (third === null) {
        throw new McoImageV4InvalidPayloadError('Invalid MCOimg v4 ellipse depth');
      }
      budget.charge({ figures: 1 });
      return one({ kind: 'ellipse', first, second, third, style });
    }
    case EXT_REPEAT_BACK: {
      const distance = reader.readBits(3) + 1;
      if (distance < 2 || distance > history.length) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 repeat back has no matching figure');
      }
      const short = reader.readBit();
      const { dx, dy } = readRepeatDelta(ctx, short);
      return one(repeatOf(budget, history[history.length - distance], dx, dy, style));
    }
    case EXT_REPEAT_COLOR_RUN: {
      if (history.length === 0) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 repeat color run has no previous figure');
      }
      const strokeColorRun = reader.readBit();
      const short = reader.readBit();
      const { dx, dy } = readRepeatDelta(ctx, short);
      const count = reader.readCompactUint() + 2;
      const hasColorChanges = reader.readBit();
      let previous = history[history.length - 1];
      // The whole run is charged before the first copy exists: count can reach ~2^35.
      chargeCopies(budget, previous, count);
      const out: V4Figure[] = [];
      let currentRunStyle = style;
      for (let index = 0; index < count; index++) {
        if (index > 0 && hasColorChanges) {
          const color = ctx.optionalColor();
          currentRunStyle = strokeColorRun ? withStroke(style, color) : withFill(style, color);
        }
        const figure = withStyle(translated(previous, dx, dy), currentRunStyle);
        out.push(figure);
        previous = figure;
      }
      return { style: currentRunStyle, figures: out };
    }
    case EXT_DOT_RUN:
      return { style, figures: readDotRun(reader, style, d, budget) };
    case EXT_PATH_ORTHOGONAL: {
      const path = readOrthogonalPath(reader, style, d, budget);
      budget.charge({ figures: 1 });
      return one(path);
    }
    case EXT_PATH_BOUNDS: {
      const path = readBoundsPath(reader, style, d, budget);
      budget.charge({ figures: 1 });
      return one(path);
    }
    case EXT_PATH_BOUNDS_DELTA: {
      const path = readBoundsDeltaPath(reader, style, d, budget);
      budget.charge({ figures: 1 });
      return one(path);
    }
    case EXT_ESCAPE: {
      const extended = reader.readBits(EXT2_BITS);
      if (extended !== EXT2_TEXT) {
        throw new McoImageV4UnsupportedFormatError(`Unknown MCOimg v4 extended command: ${extended}`);
      }
      const textFigure = readText(reader, style, textAlign, textFontSize, d, budget);
      return { style, textAlign: textFigure.align, textFontSize: textFigure.fontSize, figures: [textFigure] };
    }
    case EXT_RASTER_LAYER:
      if (!allowRasterLayer) {
        throw new McoImageV4InvalidPayloadError('MCOimg v4 raster layer is only valid in mixed mode');
      }
      return one(readRasterLayer(reader, ctx.profile, d, budget));
    case EXT_GROUP:
      return readGroup(ctx, style, textAlign, textFontSize);
    default:
      throw new McoImageV4UnsupportedFormatError(`Unknown MCOimg v4 extended opcode: ${subop}`);
  }
}

/** Codec 2386-2492: a group is a nested command stream of `count` figures. */
function readGroup(ctx: ReadContext, style: V4Style, textAlign: V4TextAlign, textFontSize: number): ExtendedReadResult {
  const { reader, dims: d, budget } = ctx;
  const count = reader.readCompactUint() + 1;
  let nestedStyle = style;
  let nestedTextAlign = textAlign;
  let nestedTextFontSize = textFontSize;
  const nestedHistory: V4Figure[] = [];
  const figures: V4Figure[] = [];

  const addNestedFigures = (next: readonly V4Figure[]): void => {
    if (figures.length + next.length > count) {
      throw new McoImageV4InvalidPayloadError('MCOimg v4 group contains too many figures');
    }
    for (const figure of next) {
      figures.push(figure);
      nestedHistory.push(figure);
    }
  };

  budget.enterGroup();
  while (figures.length < count) {
    const nestedOpcode = reader.readBits(OP_BITS);
    switch (nestedOpcode) {
      case OP_END:
        throw new McoImageV4InvalidPayloadError('Unexpected MCOimg v4 end inside group');
      case OP_SET_FILL:
        nestedStyle = withFill(nestedStyle, ctx.optionalColor());
        break;
      case OP_SET_STROKE:
        nestedStyle = withStroke(nestedStyle, ctx.optionalColor());
        break;
      case OP_SET_STROKE_WIDTH:
        nestedStyle = withStrokeWidth(nestedStyle, reader.readBits(d.scalarBits) + 1);
        break;
      case OP_REPEAT_LAST: {
        if (nestedHistory.length === 0) {
          throw new McoImageV4InvalidPayloadError('MCOimg v4 group repeat has no previous figure');
        }
        const dx = zigZagDecode(reader.readBits(d.xBits + 1));
        const dy = zigZagDecode(reader.readBits(d.yBits + 1));
        addNestedFigures([repeatOf(budget, nestedHistory[nestedHistory.length - 1], dx, dy, nestedStyle)]);
        break;
      }
      case OP_REPEAT_SHORT: {
        if (nestedHistory.length === 0) {
          throw new McoImageV4InvalidPayloadError('MCOimg v4 group repeat has no previous figure');
        }
        const shortBits = DELTA_WIDTHS[reader.readBits(2)];
        const dx = zigZagDecode(reader.readBits(shortBits));
        const dy = zigZagDecode(reader.readBits(shortBits));
        addNestedFigures([repeatOf(budget, nestedHistory[nestedHistory.length - 1], dx, dy, nestedStyle)]);
        break;
      }
      case OP_EXTENDED: {
        const result = readExtendedCommand(ctx, nestedStyle, nestedHistory, false, nestedTextAlign, nestedTextFontSize);
        nestedStyle = result.style;
        nestedTextAlign = result.textAlign ?? nestedTextAlign;
        nestedTextFontSize = result.textFontSize ?? nestedTextFontSize;
        addNestedFigures(result.figures);
        break;
      }
      default:
        addNestedFigures([readFigure(nestedOpcode, ctx, nestedStyle)]);
    }
  }
  budget.leaveGroup();
  budget.charge({ figures: 1 });
  return { style, figures: [{ kind: 'group', figures, style }] };
}
