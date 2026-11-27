import { describe, it, expect } from 'vitest';
import { paintMcoImageV4 } from './paint.js';
import type { McoPaintContext, McoPaintOptions } from './paint.js';
import type { McoImageV4Document, V4Figure, V4Style } from './model.js';

interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly fillStyle: unknown;
  readonly strokeStyle: unknown;
  readonly lineWidth: number;
  readonly font: string;
  readonly smoothing: boolean;
}

function makeCtx(ascent: number | null = 7) {
  const calls: Call[] = [];
  const state = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'round',
    font: '',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    imageSmoothingEnabled: true,
  };
  const rec =
    (name: string, ret?: () => unknown) =>
    (...args: unknown[]) => {
      calls.push({
        name,
        args,
        fillStyle: state.fillStyle,
        strokeStyle: state.strokeStyle,
        lineWidth: state.lineWidth,
        font: state.font,
        smoothing: state.imageSmoothingEnabled,
      });
      return ret?.();
    };
  const names = [
    'save', 'restore', 'setTransform', 'translate', 'scale', 'rotate', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'quadraticCurveTo', 'ellipse', 'arc', 'rect', 'clip', 'fill', 'stroke',
    'fillRect', 'clearRect', 'fillText', 'drawImage',
  ];
  const ctx: Record<string, unknown> = {};
  for (const n of names) ctx[n] = rec(n);
  // 0.5 device px per code point per px of font size
  ctx.measureText = (s: string) => {
    const size = parseFloat(state.font);
    return { width: [...s].length * 0.5 * size, actualBoundingBoxAscent: ascent ?? undefined } as TextMetrics;
  };
  Object.defineProperties(
    ctx,
    Object.fromEntries(
      (Object.keys(state) as (keyof typeof state)[]).map((k) => [
        k,
        { get: () => state[k], set: (v: never) => ((state as Record<string, unknown>)[k] = v), enumerable: true },
      ]),
    ),
  );
  const named = (n: string) => calls.filter((c) => c.name === n);
  return { ctx: ctx as unknown as McoPaintContext, calls, state, named };
}

const S = (stroke: number | null, fill: number | null = null, w = 1): V4Style => ({ fill, stroke, strokeWidth: w });
const doc = (
  figures: V4Figure[],
  extra: Partial<McoImageV4Document> = {},
): McoImageV4Document => ({
  mode: 'vector',
  width: 16,
  height: 16,
  paletteProfile: 1,
  // profile 1 palette: white, silver, 5658198, black
  palette: [3, 0, 2],
  background: null,
  initialStyle: S(0),
  figures,
  ...extra,
});
const opts = (o: Partial<McoPaintOptions> = {}): McoPaintOptions => ({
  pixelWidth: 32,
  pixelHeight: 32,
  fontFamily: 'Foo',
  ...o,
});
const BLACK = '#000000';
const WHITE = '#ffffff';

describe('paintMcoImageV4 frame', () => {
  it('scales into a square backing store and clips to the canvas', () => {
    const { ctx, calls, named } = makeCtx();
    paintMcoImageV4(ctx, doc([]), opts());
    expect(named('translate')[0].args).toEqual([0, 0]);
    expect(named('scale')[0].args).toEqual([2, 2]);
    expect(named('rect')[0].args).toEqual([0, 0, 16, 16]);
    expect(named('clip')).toHaveLength(1);
    expect(calls[0].name).toBe('save');
    expect(calls[calls.length - 1].name).toBe('restore');
  });

  it('centres a non-square canvas in a wide backing store', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([], { width: 16, height: 8 }), opts({ pixelWidth: 64, pixelHeight: 64 }));
    expect(named('scale')[0].args).toEqual([4, 4]);
    expect(named('translate')[0].args).toEqual([0, 16]);
    expect(named('rect')[0].args).toEqual([0, 0, 16, 8]);
  });

  it('letterboxes a square canvas in a wide backing store', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([]), opts({ pixelWidth: 64, pixelHeight: 32 }));
    expect(named('scale')[0].args).toEqual([2, 2]);
    expect(named('translate')[0].args).toEqual([16, 0]);
  });

  it('sets square caps and miter joins', () => {
    const { ctx, state } = makeCtx();
    paintMcoImageV4(ctx, doc([]), opts());
    expect(state.lineCap).toBe('square');
    expect(state.lineJoin).toBe('miter');
  });

  it('fills the background when set, and not when transparent', () => {
    const a = makeCtx();
    paintMcoImageV4(a.ctx, doc([], { background: 1 }), opts());
    expect(a.named('fillRect')).toHaveLength(1);
    expect(a.named('fillRect')[0].args).toEqual([0, 0, 16, 16]);
    expect(a.named('fillRect')[0].fillStyle).toBe(WHITE);
    const b = makeCtx();
    paintMcoImageV4(b.ctx, doc([]), opts());
    expect(b.named('fillRect')).toHaveLength(0);
  });
});

describe('paintMcoImageV4 figures', () => {
  it('draws a dot at the cell centre in the stroke colour', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([{ kind: 'dot', point: { x: 3, y: 4 }, style: S(0, null, 3) }]), opts());
    expect(named('arc')[0].args).toEqual([3.5, 4.5, 1.5, 0, Math.PI * 2]);
    expect(named('fill')[0].fillStyle).toBe(BLACK);
    expect(named('stroke')).toHaveLength(0);
  });

  it('draws nothing for a dot or line with a null stroke', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'dot', point: { x: 1, y: 1 }, style: S(null, 1) },
        { kind: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 5 }, style: S(null, 1) },
      ]),
      opts(),
    );
    expect(named('fill')).toHaveLength(0);
    expect(named('stroke')).toHaveLength(0);
    expect(named('arc')).toHaveLength(0);
  });

  it('strokes a line between cell centres with the stroke width', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([{ kind: 'line', start: { x: 1, y: 2 }, end: { x: 5, y: 6 }, style: S(0, 1, 2) }]), opts());
    expect(named('moveTo')[0].args).toEqual([1.5, 2.5]);
    expect(named('lineTo')[0].args).toEqual([5.5, 6.5]);
    expect(named('stroke')[0].lineWidth).toBe(2);
    expect(named('stroke')[0].strokeStyle).toBe(BLACK);
    expect(named('fill')).toHaveLength(0);
  });

  it('draws a rect through first, third, second, first+second-third and closes it', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        {
          kind: 'rect',
          first: { x: 0, y: 0 },
          second: { x: 4, y: 3 },
          third: { x: 4, y: 0 },
          style: S(0),
        },
      ]),
      opts(),
    );
    const path = calls.filter((c) => ['moveTo', 'lineTo', 'closePath', 'stroke'].includes(c.name));
    expect(path.map((c) => [c.name, ...c.args])).toEqual([
      ['moveTo', 0.5, 0.5],
      ['lineTo', 4.5, 0.5],
      ['lineTo', 4.5, 3.5],
      ['lineTo', 0.5, 3.5],
      ['closePath'],
      ['stroke'],
    ]);
  });

  it('fills before it strokes', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'rect', first: { x: 0, y: 0 }, second: { x: 4, y: 3 }, third: { x: 4, y: 0 }, style: S(0, 1) },
      ]),
      opts(),
    );
    const names = calls.map((c) => c.name);
    expect(names.indexOf('fill')).toBeLessThan(names.indexOf('stroke'));
    expect(calls[names.indexOf('fill')].fillStyle).toBe(WHITE);
  });

  it('draws an ellipse with centre, radii and rotation', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'ellipse', first: { x: 0, y: 4 }, second: { x: 8, y: 4 }, third: { x: 4, y: 7 }, style: S(0) },
      ]),
      opts(),
    );
    expect(named('ellipse')[0].args).toEqual([4.5, 4.5, 4, 3, 0, 0, Math.PI * 2]);
  });

  it('rotates a slanted ellipse by the axis angle', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'ellipse', first: { x: 0, y: 0 }, second: { x: 0, y: 6 }, third: { x: 2, y: 3 }, style: S(0) },
      ]),
      opts(),
    );
    const args = named('ellipse')[0].args;
    expect(args.slice(0, 4)).toEqual([0.5, 3.5, 3, 2]);
    expect(args[4]).toBeCloseTo(Math.PI / 2);
  });

  it('draws a thin ellipse as its axis line, open', () => {
    const { ctx, calls, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'ellipse', first: { x: 0, y: 4 }, second: { x: 8, y: 4 }, third: { x: 4, y: 4 }, style: S(0) },
      ]),
      opts(),
    );
    expect(named('ellipse')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'closePath')).toHaveLength(0);
    expect(named('lineTo')[0].args).toEqual([8.5, 4.5]);
    expect(named('stroke')).toHaveLength(1);
  });

  it('draws nothing for an ellipse with a zero-length axis', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([{ kind: 'ellipse', first: { x: 2, y: 2 }, second: { x: 2, y: 2 }, third: { x: 4, y: 4 }, style: S(0) }]),
      opts(),
    );
    expect(calls.filter((c) => c.name === 'stroke' || c.name === 'fill')).toHaveLength(0);
  });

  it('draws a wave as a quadratic with the control point off the chord', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([{ kind: 'wave', start: { x: 0, y: 0 }, end: { x: 8, y: 0 }, depth: 2, closed: false, style: S(0) }]),
      opts(),
    );
    expect(named('moveTo')[0].args).toEqual([0.5, 0.5]);
    // normal = (-dy, dx) / len = (0, 1); control = mid + normal * 2 * depth
    expect(named('quadraticCurveTo')[0].args).toEqual([4.5, 4.5, 8.5, 0.5]);
  });

  it('draws nothing for a zero-length wave', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([{ kind: 'wave', start: { x: 2, y: 2 }, end: { x: 2, y: 2 }, depth: 2, closed: false, style: S(0) }]),
      opts(),
    );
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(0);
  });

  it('offsets path points by half a cell, leaves an open stroke open, and closes an open fill', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'path', points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }], closed: false, style: S(0, 1) },
      ]),
      opts(),
    );
    const names = calls.map((c) => c.name);
    expect(calls.filter((c) => c.name === 'moveTo')[0].args).toEqual([1.5, 1.5]);
    // fill pass closes; stroke pass does not
    expect(names.filter((n) => n === 'closePath')).toHaveLength(1);
    expect(names.indexOf('closePath')).toBeLessThan(names.indexOf('fill'));
    expect(names.lastIndexOf('stroke')).toBeGreaterThan(names.indexOf('fill'));
  });

  it('closes a closed path stroke', () => {
    const { ctx, calls } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([{ kind: 'path', points: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }], closed: true, style: S(0) }]),
      opts(),
    );
    const names = calls.map((c) => c.name);
    expect(names.indexOf('closePath')).toBeLessThan(names.indexOf('stroke'));
  });

  it('draws a raster layer at an integer origin with smoothing off', () => {
    const { ctx, named } = makeCtx();
    const source = {} as CanvasImageSource;
    const seen: [number, number][] = [];
    paintMcoImageV4(
      ctx,
      doc([
        {
          kind: 'raster',
          x: 3,
          y: 5,
          width: 2,
          height: 2,
          pixels: [0, 0, 0, 0],
          transparentColor: null,
          rgba: new Uint8ClampedArray(16),
        },
      ]),
      opts({
        createLayerSource: (_rgba, w, h) => {
          seen.push([w, h]);
          return source;
        },
      }),
    );
    expect(seen).toEqual([[2, 2]]);
    expect(named('drawImage')[0].args).toEqual([source, 3, 5, 2, 2]);
    expect(named('drawImage')[0].smoothing).toBe(false);
  });

  it('skips a raster layer whose source cannot be built', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(
      ctx,
      doc([
        { kind: 'raster', x: 0, y: 0, width: 1, height: 1, pixels: [0], transparentColor: null, rgba: new Uint8ClampedArray(4) },
      ]),
      opts({ createLayerSource: () => null }),
    );
    expect(named('drawImage')).toHaveLength(0);
  });

  it('draws group children in order', () => {
    const { ctx, named } = makeCtx();
    const dot = (x: number): V4Figure => ({ kind: 'dot', point: { x, y: 0 }, style: S(0) });
    paintMcoImageV4(
      ctx,
      doc([dot(1), { kind: 'group', figures: [dot(2), { kind: 'group', figures: [dot(3)], style: S(0) }], style: S(0) }, dot(4)]),
      opts(),
    );
    expect(named('arc').map((c) => c.args[0])).toEqual([1.5, 2.5, 3.5, 4.5]);
  });
});

const text = (over: Partial<Extract<V4Figure, { kind: 'text' }>> = {}): V4Figure => ({
  kind: 'text',
  origin: { x: 2, y: 3 },
  width: 8,
  fontSize: 3,
  align: 'left',
  text: 'ab',
  style: S(0),
  ...over,
});

describe('paintMcoImageV4 text', () => {
  it('draws in device pixels with the scaled font and page font family', () => {
    const { ctx, named, calls } = makeCtx();
    paintMcoImageV4(ctx, doc([text()]), opts());
    const t = named('fillText')[0];
    expect(t.font).toBe('6px Foo');
    expect(t.fillStyle).toBe(BLACK);
    // the transform is reset inside the text block
    const names = calls.map((c) => c.name);
    expect(names.indexOf('setTransform', names.indexOf('clip'))).toBeGreaterThan(-1);
    // lineBox(3) = 4; capHeight 7 device px = 3.5 cells; baseline = 3.5 + (4 + 3.5) / 2 = 7.25 cells = 14.5 px
    expect(t.args).toEqual(['ab', 5, 14.5]);
  });

  it('positions centred and right-aligned lines inside the area', () => {
    // 'ab' = 2 * 0.5 * 6px = 6px = 3 cells wide
    const c = makeCtx();
    paintMcoImageV4(c.ctx, doc([text({ align: 'center' })]), opts());
    expect(c.named('fillText')[0].args[1]).toBe((2.5 + (8 - 3) / 2) * 2);
    const r = makeCtx();
    paintMcoImageV4(r.ctx, doc([text({ align: 'right' })]), opts());
    expect(r.named('fillText')[0].args[1]).toBe((2.5 + (8 - 3)) * 2);
  });

  it('places wrapped lines one line box apart', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([text({ text: 'ab\ncd', width: 8 })]), opts());
    const ys = named('fillText').map((c) => c.args[2] as number);
    expect(ys[1] - ys[0]).toBe(4 * 2);
  });

  it('fills the text area with the fill colour, sized by lines', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([text({ text: 'ab\ncd', style: S(0, 1) })]), opts());
    const r = named('fillRect')[0];
    expect(r.args).toEqual([5, 7, 16, 16]); // origin (2.5,3.5) cells * 2; 8 wide, 2 lines * 4
    expect(r.fillStyle).toBe(WHITE);
  });

  it('draws no glyphs when the stroke is null, only the fill', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([text({ style: S(null, 1) })]), opts());
    expect(named('fillText')).toHaveLength(0);
    expect(named('fillRect')).toHaveLength(1);
  });

  it('draws nothing when both stroke and fill are null', () => {
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([text({ style: S(null, null) })]), opts());
    expect(named('fillText')).toHaveLength(0);
    expect(named('fillRect')).toHaveLength(0);
  });

  it('falls back to 0.727 em when the cap height cannot be measured', () => {
    const { ctx, named } = makeCtx(null);
    paintMcoImageV4(ctx, doc([text()]), opts());
    const capCells = 0.727 * 3;
    const baseline = 3.5 + (4 + capCells) / 2;
    expect(named('fillText')[0].args[2]).toBeCloseTo(baseline * 2);
  });

  it('uses the rest of the row as the default width', () => {
    // origin x 12 on a 16 canvas: width 4 cells = 8 device px; 'abcd' is 12px so it wraps
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, doc([text({ origin: { x: 12, y: 0 }, width: null, text: 'abcd' })]), opts());
    expect(named('fillText').length).toBeGreaterThan(1);
  });
});

describe('paintMcoImageV4 reporter sample', () => {
  it('paints without throwing and issues the text blocks', async () => {
    const { decodeMcoImageText } = await import('../decode.js');
    const fs = await import('node:fs');
    const path = process.env.MCO_REPORTER_SAMPLE;
    if (!path) return;
    const image = decodeMcoImageText(fs.readFileSync(path, 'utf8').trim());
    expect(image?.format).toBe('im4');
    if (image?.format !== 'im4') return;
    const { ctx, named } = makeCtx();
    paintMcoImageV4(ctx, image.document, opts({ pixelWidth: 512, pixelHeight: 512, createLayerSource: () => null }));
    expect(named('fillText').length).toBeGreaterThanOrEqual(7);
  });
});
