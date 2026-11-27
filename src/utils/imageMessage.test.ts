import { describe, it, expect } from 'vitest';
import { isImageMessageText } from './imageMessage.js';
import fixtures from './mcoImage/__fixtures__/v4-differential-fixtures.json';

const IM4 = fixtures.entries.find((e) => e.name === 'reporter-6586')!.text;

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

describe('isImageMessageText', () => {
  it('is true for a SPIP code and an IM3 payload', () => {
    expect(isImageMessageText('3:yzyzyzyzy')).toBe(true);
    expect(isImageMessageText(SAMPLE)).toBe(true);
  });

  it('is true for an IM4 payload, false when mixed with text', () => {
    expect(isImageMessageText(IM4)).toBe(true);
    expect(isImageMessageText(`hi ${IM4}`)).toBe(false);
  });

  it.each([
    ['plain text', 'hello there'],
    ['a clock time', '12:30'],
    ['mixed im3 text', `look ${SAMPLE}`],
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('is false for %s', (_n, text) => {
    expect(isImageMessageText(text as string | null | undefined)).toBe(false);
  });
});
