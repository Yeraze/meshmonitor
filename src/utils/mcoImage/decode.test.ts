import { describe, expect, it } from 'vitest';
import { decodeMcoImageText } from './decode.js';

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
    ['im4', SAMPLE.replace('im3:', 'im4:')],
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
});
