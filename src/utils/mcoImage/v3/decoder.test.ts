import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeV3Text } from './decoder.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { PaletteProfile } from './constants.js';

const SAMPLE = 'im3:2nTxb8bL@u#f!+~Xv(}LpQrfRJ+tBMPKr*JTvu0t6EbJbeD"%qhto7o)L(:>=5Mf%u}"[7EE%MACq%H"EA';

describe('decodeV3Text', () => {
  it('decodes the reporter sample', () => {
    const img = decodeV3Text(SAMPLE);
    expect(img.width).toBe(48);
    expect(img.height).toBe(22);
    expect(img.paletteProfile).toBe(PaletteProfile.dynamicGlobal512);
    expect(img.transparentColor).toBeNull();
    expect(img.pixels).toHaveLength(1056);
    expect(Array.from(new Set(img.pixels)).sort((a, b) => a - b)).toEqual([27, 36, 45, 72, 85]);
    const hash = createHash('sha256').update(JSON.stringify(img.pixels)).digest('hex');
    expect(hash).toBe('7e73ecfb7b8c4d6116511986962e2db50a06287d863cd4ae7234400a0bbf2f4a');
  });

  it('decodes a 256x256 solid image (boundary)', () => {
    const img = decodeV3Text('im3:2n1(VLCA');
    expect(img.width).toBe(256);
    expect(img.height).toBe(256);
    expect(img.pixels).toHaveLength(65536);
    expect(img.pixels.every((p) => p === 0)).toBe(true);
  });

  const failures: Array<[string, string, string]> = [
    ['truncated sample', SAMPLE.slice(0, -3), 'Unexpected end of bits'],
    ['trailing bytes', `${SAMPLE}A`, 'Trailing payload bytes'],
    ['wrong subtype', 'im3:1n1(VLCA', 'Unsupported MCOimg app subtype/version 0x12'],
    ['mutated container', 'im3:g/LAAA0|GA', 'Scan-independent v3 block must use compactBlock'],
    ['empty payload', 'im3:', 'Unsupported MCOimg app subtype/version empty'],
    ['uppercase prefix', SAMPLE.replace('im3:', 'IM3:'), 'Missing im3: prefix'],
  ];
  it.each(failures)('rejects %s', (_label, text, message) => {
    expect(() => decodeV3Text(text)).toThrow(McoImageV3InvalidPayloadError);
    expect(() => decodeV3Text(text)).toThrow(message);
  });
});
