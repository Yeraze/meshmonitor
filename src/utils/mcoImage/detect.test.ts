import { describe, it, expect } from 'vitest';
import { detectMcoImage, isMcoImageCandidate, MCO_IMAGE_MAX_TEXT_LENGTH } from './detect.js';

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';
const IM4_LIKE = 'im4:2nTxb8bL@u#f!+~Xv(}LpQrfRJ';

describe('detectMcoImage', () => {
  it('accepts the reporter sample', () => {
    expect(detectMcoImage(SAMPLE)).toEqual({ format: 'im3', payload: SAMPLE });
  });

  it('trims surrounding whitespace and returns the trimmed payload', () => {
    expect(detectMcoImage(`  ${SAMPLE}\n`)?.payload).toBe(SAMPLE);
    expect(detectMcoImage(`\n\t${SAMPLE} \r\n`)?.payload).toBe(SAMPLE);
  });

  it('accepts the smallest valid payload', () => {
    expect(detectMcoImage('im3:2n1(VLCA')?.payload).toBe('im3:2n1(VLCA');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['mid-sentence', `look ${SAMPLE}`],
    ['trailing words', `${SAMPLE} thanks`],
    ['uppercase prefix', SAMPLE.replace('im3:', 'IM3:')],
    ['mixed-case prefix', SAMPLE.replace('im3:', 'Im3:')],
    ['im4 in phase 1', IM4_LIKE],
    ['prefix alone', 'im3:'],
    ['5 payload chars', 'im3:ABCDE'],
    ['too long', `im3:${'A'.repeat(MCO_IMAGE_MAX_TEXT_LENGTH - 3)}`],
    ['internal space', 'im3:2nTxb8 bL@u#f'],
    ['hyphen', 'im3:2nTxb8-bL@u#f'],
    ['apostrophe', "im3:2nTxb8'bL@u#f"],
    ['backslash', 'im3:2nTxb8\\bL@u#f'],
    ['two payloads on lines', `${SAMPLE}\n${SAMPLE}`],
  ])('rejects %s', (_label, input) => {
    expect(detectMcoImage(input as string | null | undefined)).toBeNull();
  });

  it('accepts exactly the max length', () => {
    const t = `im3:${'A'.repeat(MCO_IMAGE_MAX_TEXT_LENGTH - 4)}`;
    expect(t.length).toBe(MCO_IMAGE_MAX_TEXT_LENGTH);
    expect(detectMcoImage(t)).not.toBeNull();
  });

  it('isMcoImageCandidate agrees with detectMcoImage', () => {
    for (const v of [SAMPLE, `x ${SAMPLE}`, null, undefined, '', IM4_LIKE, 'im3:2n1(VLCA']) {
      expect(isMcoImageCandidate(v)).toBe(detectMcoImage(v) !== null);
    }
  });
});
