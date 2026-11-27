import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeMcoImageText } from './decode.js';

interface Im4Fixture {
  name: string;
  text: string;
  result: 'ok' | 'invalid' | 'unsupported';
  dump?: { width: number; height: number };
}
const im4Entries = (
  JSON.parse(readFileSync(new URL('./__fixtures__/v4-reference-fixtures.json', import.meta.url), 'utf8')) as {
    entries: Im4Fixture[];
  }
).entries;

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';

describe('decodeMcoImageText', () => {
  it('decodes the sample to RGBA', () => {
    const img = decodeMcoImageText(SAMPLE);
    expect(img).not.toBeNull();
    expect(img?.format).toBe('im3');
    expect(img?.width).toBe(48);
    expect(img?.height).toBe(22);
    expect(img?.rgba.length).toBe(48 * 22 * 4);
  });

  it('accepts surrounding whitespace', () => {
    expect(decodeMcoImageText(`\n ${SAMPLE} `)?.width).toBe(48);
  });

  it.each([
    ['mixed text', `${SAMPLE} thanks`],
    ['uppercase prefix', SAMPLE.replace('im3:', 'IM3:')],
    ['truncated', SAMPLE.slice(0, -3)],
    ['trailing char', `${SAMPLE}A`],
    ['im3 body under im4 prefix', SAMPLE.replace('im3:', 'im4:')],
    ['empty', ''],
  ])('returns null for %s', (_label, text) => {
    expect(decodeMcoImageText(text)).toBeNull();
  });

  it('returns the identical object on a second call (memo)', () => {
    const a = decodeMcoImageText(SAMPLE);
    expect(decodeMcoImageText(SAMPLE)).toBe(a);
  });

  it('never throws on random alphabet strings', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 1000; i++) {
      const len = 6 + (rnd() % 60);
      let s = 'im3:';
      for (let j = 0; j < len; j++) s += ALPHABET[rnd() % ALPHABET.length];
      expect(() => decodeMcoImageText(s)).not.toThrow();
    }
  });

  describe('im4', () => {
    const okWithText = im4Entries.find((e) => e.result === 'ok' && e.name.includes('round-trips a default layer'));

    it('decodes an im4 image to a document with captions', () => {
      expect(okWithText).toBeDefined();
      const img = decodeMcoImageText(okWithText?.text ?? '');
      expect(img?.format).toBe('im4');
      if (img?.format !== 'im4') throw new Error('not im4');
      expect(img.width).toBe(okWithText?.dump?.width);
      expect(img.height).toBe(okWithText?.dump?.height);
      expect(img.document.figures.length).toBeGreaterThan(0);
      expect(Array.isArray(img.captions)).toBe(true);
    });

    it('decodes every valid reference fixture and returns null for every other one', () => {
      for (const entry of im4Entries) {
        const img = decodeMcoImageText(entry.text);
        if (entry.result === 'ok') {
          // Only ones the shared detector accepts (text length limit, 5+ chars) are drawn.
          if (img !== null) expect(img.format).toBe('im4');
        } else {
          expect(img, entry.name).toBeNull();
        }
      }
    });

    it('returns null for unsupported fixtures (mode 2, ext2 command 1, MCOtxt version 2)', () => {
      const unsupported = im4Entries.filter((e) => e.result === 'unsupported');
      expect(unsupported.length).toBe(4);
      for (const entry of unsupported) expect(decodeMcoImageText(entry.text)).toBeNull();
    });

    it('draws the reporter sample with its captions', () => {
      const diff = (
        JSON.parse(readFileSync(new URL('./__fixtures__/v4-differential-fixtures.json', import.meta.url), 'utf8')) as {
          entries: Array<{ name: string; text: string }>;
        }
      ).entries;
      const reporter = diff.find((e) => e.name === 'reporter-6586');
      const img = decodeMcoImageText(reporter?.text ?? '');
      expect(img?.format).toBe('im4');
      if (img?.format !== 'im4') throw new Error('not im4');
      expect([img.width, img.height]).toEqual([48, 33]);
      expect(img.captions).toContain('Queens Weather');
      expect(img.captions).toContain('RH 82% ↙ NE 15 30.43↓');
    });

    it('caches im4 results too', () => {
      const text = okWithText?.text ?? '';
      expect(decodeMcoImageText(text)).toBe(decodeMcoImageText(text));
    });
  });
});
