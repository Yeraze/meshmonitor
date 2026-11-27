import { describe, it, expect } from 'vitest';
import { isImageMessageText } from './imageMessage.js';

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

describe('isImageMessageText', () => {
  it('is true for a SPIP code and an IM3 payload', () => {
    expect(isImageMessageText('3:yzyzyzyzy')).toBe(true);
    expect(isImageMessageText(SAMPLE)).toBe(true);
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
