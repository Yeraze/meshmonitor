import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { base91Decode, base91Encode, BASE91_ALPHABET } from './base91.js';
import { McoImageV3InvalidPayloadError } from './v3/errors.js';
import decoderFixtures from './__fixtures__/v3-js-decoder-fixtures.json';
import encoderFixtures from './__fixtures__/v3-js-encoder-fixtures.json';

interface Fixture { name: string; text: string; appPayloadBase64: string }

describe('base91', () => {
  it('has 91 distinct characters', () => {
    expect(BASE91_ALPHABET.length).toBe(91);
    expect(new Set(BASE91_ALPHABET).size).toBe(91);
  });

  it.each([...(decoderFixtures.fixtures as Fixture[]), ...(encoderFixtures.fixtures as Fixture[])].map((f) => [f.name, f] as const))(
    'decodes fixture %s to its app payload',
    (_name, f) => {
      const bytes = base91Decode(f.text.slice('im3:'.length));
      expect(Buffer.from(bytes).toString('base64')).toBe(f.appPayloadBase64);
      expect(base91Encode(bytes)).toBe(f.text.slice('im3:'.length));
    },
  );

  it('round-trips 200 random byte arrays', () => {
    for (let i = 0; i < 200; i++) {
      const bytes = new Uint8Array(randomBytes(i % 301));
      expect(Array.from(base91Decode(base91Encode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it.each([' ', '-', "'", '\\'])('throws on invalid character %j', (ch) => {
    expect(() => base91Decode(`AB${ch}CD`)).toThrow(McoImageV3InvalidPayloadError);
    expect(() => base91Decode(`AB${ch}CD`)).toThrow('Invalid basE91 character');
  });
});
