import { describe, it, expect } from 'vitest';
import { detectMcoImage, isMcoImageCandidate, MCO_IMAGE_MAX_TEXT_LENGTH } from './detect.js';
import { base91Encode } from './base91.js';

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';
const IM4_SAMPLE = `im4:${base91Encode(Uint8Array.of(0x00, 0x08, 0x0f, 0x00))}`;
const IM4_LIKE = 'im4:2nTxb8bL@u#f!+~Xv(}LpQrfRJ';

describe('detectMcoImage', () => {
  it('accepts the reporter sample', () => {
    expect(detectMcoImage(SAMPLE)).toEqual({ format: 'im3', payload: SAMPLE });
  });

  it('trims surrounding whitespace and returns the trimmed payload', () => {
    expect(detectMcoImage(`  ${SAMPLE}\n`)?.payload).toBe(SAMPLE);
    expect(detectMcoImage(`\n\t${SAMPLE} \r\n`)?.payload).toBe(SAMPLE);
  });

  it('accepts im4 payloads, smallest body included', () => {
    expect(IM4_SAMPLE.length - 4).toBe(5);
    expect(detectMcoImage(IM4_SAMPLE)).toEqual({ format: 'im4', payload: IM4_SAMPLE });
    expect(detectMcoImage(IM4_LIKE)).toEqual({ format: 'im4', payload: IM4_LIKE });
    expect(detectMcoImage(`  ${IM4_LIKE}\n`)?.payload).toBe(IM4_LIKE);
    expect(detectMcoImage(`im4:${'A'.repeat(MCO_IMAGE_MAX_TEXT_LENGTH - 4)}`)).not.toBeNull();
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
    ['uppercase im4 prefix', IM4_LIKE.replace('im4:', 'IM4:')],
    ['im4 with space before colon', 'im4 :2nTxb8bL@u#f'],
    ['im5 prefix', 'im5:2nTxb8bL@u#f'],
    ['im4 with 4 payload chars', 'im4:ABCD'],
    ['im4 mid-sentence', `see ${IM4_LIKE}`],
    ['im4 non-alphabet char', 'im4:2nTxb8-bL@u#f'],
    ['im4 too long', `im4:${'A'.repeat(MCO_IMAGE_MAX_TEXT_LENGTH - 3)}`],
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
    for (const v of [SAMPLE, `x ${SAMPLE}`, null, undefined, '', IM4_LIKE, IM4_SAMPLE, 'im4:ABCD', 'im3:2n1(VLCA']) {
      expect(isMcoImageCandidate(v)).toBe(detectMcoImage(v) !== null);
    }
  });
});
