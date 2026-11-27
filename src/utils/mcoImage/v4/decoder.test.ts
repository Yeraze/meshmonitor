import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMcoImageText } from '../decode.js';
import { decodeV4Body, decodeV4Text } from './decoder.js';
import {
  McoImageV4CodecError,
  McoImageV4InvalidPayloadError,
  McoImageV4UnsupportedFormatError,
} from './errors.js';
import { V4TestDoc } from './testBuilders.js';

interface DiffEntry {
  name: string;
  text: string;
}
const entries = (
  JSON.parse(readFileSync(new URL('../__fixtures__/v4-differential-fixtures.json', import.meta.url), 'utf8')) as {
    entries: DiffEntry[];
  }
).entries;
const reporter = entries.find((e) => e.name === 'reporter-6586');

describe('reporter sample (#6586)', () => {
  it('is in the fixtures', () => {
    expect(reporter).toBeDefined();
  });

  it('decodes to the vector document the reference app shows', () => {
    const { document } = decodeV4Text(reporter?.text ?? '');
    expect(document.mode).toBe('vector');
    expect(document.width).toBe(48);
    expect(document.height).toBe(33);
    expect(document.figures).toHaveLength(16);
    const texts = document.figures.filter((f) => f.kind === 'text');
    expect(texts).toHaveLength(7);
    const first = texts[0];
    expect(first.kind === 'text' && first.text).toBe('Queens Weather');
    expect(first.kind === 'text' && first.align).toBe('center');
    const last = texts[texts.length - 1];
    expect(last.kind === 'text' && last.text).toBe('43°');
    expect(last.kind === 'text' && last.fontSize).toBe(8);
    expect(document.figures.filter((f) => f.kind === 'rect')).toHaveLength(1);
    expect(document.figures.filter((f) => f.kind === 'ellipse')).toHaveLength(5);
    expect(document.figures.filter((f) => f.kind === 'line')).toHaveLength(3);
  });

  it('keeps the multi-line text blocks', () => {
    const { document } = decodeV4Text(reporter?.text ?? '');
    const all = document.figures.flatMap((f) => (f.kind === 'text' ? [f.text] : []));
    expect(all).toContain('Feels 34\nH55 L42');
    expect(all).toContain('RH 82%\n↙ NE 15\n30.43↓');
  });

  it('is drawn by decodeMcoImageText', () => {
    const img = decodeMcoImageText(reporter?.text ?? '');
    expect(img?.format).toBe('im4');
    expect(img?.width).toBe(48);
    expect(img?.height).toBe(33);
  });
});

describe('transport tail', () => {
  const base = (): V4TestDoc => new V4TestDoc().dot(10, 10).end();
  const name = new TextEncoder().encode('Bob');

  it('reads nonce, target name and reply timestamp', () => {
    const tail = Uint8Array.of(0x03, 3, ...name, 0x78, 0x56, 0x34, 0xf2);
    const decoded = decodeV4Body(base().body(200, tail));
    expect(decoded.nonce).toBe(200);
    expect(decoded.targetName).toBe('Bob');
    expect(decoded.replyTimestamp).toBe(0xf2345678);
  });

  it('has no tail by default', () => {
    const decoded = decodeV4Body(base().body());
    expect(decoded.targetName).toBeNull();
    expect(decoded.replyTimestamp).toBeNull();
  });

  it.each([
    ['unknown flags', Uint8Array.of(0x04), 'Unknown v4 transport flags'],
    ['empty name', Uint8Array.of(0x01, 0x00), 'Empty v4 target name'],
    ['trailing bytes', Uint8Array.of(0x02, 1, 2, 3, 4, 5), 'Trailing v4 transport bytes'],
    ['short timestamp', Uint8Array.of(0x02, 1, 2), 'Unexpected end of v4 bytes'],
  ])('rejects %s', (_label, tail, message) => {
    expect(() => decodeV4Body(base().body(1, tail))).toThrow(message);
  });

  it('rejects malformed UTF-8 in the target name as an invalid payload', () => {
    expect(() => decodeV4Body(base().body(1, Uint8Array.of(0x01, 1, 0xff)))).toThrow(McoImageV4InvalidPayloadError);
  });
});

describe('error classes', () => {
  it('rejects an empty body and a non-im4 text', () => {
    expect(() => decodeV4Body(new Uint8Array())).toThrow('MCOimg v4 payload too short');
    expect(() => decodeV4Text('im3:abcdef')).toThrow('Not an MCOimg v4 text');
  });

  it('treats modes 2 and 3 as unsupported', () => {
    for (const mode of [2, 3]) {
      const body = Uint8Array.of(0, mode, 0, 0, 0);
      expect(() => decodeV4Body(body)).toThrow(McoImageV4UnsupportedFormatError);
    }
  });

  it('rejects a mixed document without raster layers', () => {
    const body = new V4TestDoc({ mixed: true }).dot(1, 1).end().body();
    expect(() => decodeV4Body(body)).toThrow('MCOimg v4 mixed document has no raster layers');
  });

  it('rejects non-zero padding', () => {
    const doc = new V4TestDoc().end().body();
    doc[doc.length - 1] |= 0x80;
    expect(() => decodeV4Body(doc)).toThrow('Non-zero MCOimg v4 padding');
  });

  it('only ever throws the v4 error family, even on random bytes', () => {
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 3000; i++) {
      const bytes = Uint8Array.from({ length: 4 + (rnd() % 40) }, () => rnd() & 0xff);
      try {
        decodeV4Body(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(McoImageV4CodecError);
      }
    }
  });
});
