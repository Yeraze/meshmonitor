import { describe, expect, it } from 'vitest';
import fixtures from '../__fixtures__/mcotxt-reference-fixtures.json';
import { decodeMcotxtStream } from './decoder.js';
import { McotxtCodecError, MCOTXT_UNSUPPORTED_CODES } from './errors.js';
import type { McotxtErrorCode } from './errors.js';

interface Entry {
  set: string;
  name: string;
  dataHex: string;
  bitLength: number;
  text: string | null;
  error: string | null;
  languageA?: string | null;
  languageB?: string | null;
  modelGeneration?: number;
}

const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Pack a string of '0'/'1' (spaces ignored) into bytes, MSB first. */
function bits(spec: string): { data: Uint8Array; bitLength: number } {
  const s = spec.replace(/\s+/g, '');
  const data = new Uint8Array(Math.ceil(s.length / 8));
  for (let i = 0; i < s.length; i++) if (s[i] === '1') data[i >> 3]! |= 0x80 >> (i & 7);
  return { data, bitLength: s.length };
}

function codeOf(fn: () => unknown): McotxtErrorCode {
  try {
    fn();
  } catch (error) {
    if (error instanceof McotxtCodecError) return error.code;
    throw error;
  }
  throw new Error('expected McotxtCodecError');
}

const decodeBits = (spec: string) => {
  const { data, bitLength } = bits(spec);
  return decodeMcotxtStream(data, bitLength);
};

describe('decodeMcotxtStream: reference fixtures', () => {
  const entries = (fixtures as { entries: Entry[] }).entries;
  it('has fixtures of both kinds', () => {
    expect(entries.length).toBeGreaterThan(300);
    expect(entries.filter((e) => e.error !== null).length).toBeGreaterThan(5);
  });
  entries.forEach((entry, index) => {
    it(`#${index} ${entry.set}: ${entry.name}`, () => {
      const data = hex(entry.dataHex);
      if (entry.error !== null) {
        expect(codeOf(() => decodeMcotxtStream(data, entry.bitLength))).toBe(entry.error);
        return;
      }
      const result = decodeMcotxtStream(data, entry.bitLength);
      expect(result.text).toBe(entry.text);
      if (entry.languageA !== undefined) expect(result.languageA).toBe(entry.languageA);
      if (entry.languageB !== undefined) expect(result.languageB).toBe(entry.languageB);
      if (entry.modelGeneration !== undefined) expect(result.modelGeneration).toBe(entry.modelGeneration);
    });
  });
});

describe('decodeMcotxtStream: hand cases', () => {
  // header: version 001, generation 000, language A en 000, B none 111
  const HEAD = '001 000 000 111';

  it('decodes a header-only stream to empty text', () => {
    expect(decodeBits(HEAD)).toMatchObject({ text: '', mode: 'mcotxt', modelGeneration: 0, languageA: 'en', languageB: null });
  });

  it('decodes punctuation and primary literals', () => {
    // punctuation id 3 ('!'): 110 00011; primary id 1 ('o'): 10 00001
    expect(decodeBits(`${HEAD} 110 00011 10 00001`).text).toBe('!o');
  });

  it('SHIFT uppercases one symbol; CAPS_MODE inverts it', () => {
    // SHIFT = 11110; primary id 1 -> 'O'
    expect(decodeBits(`${HEAD} 11110 10 00001`).text).toBe('O');
    // TOGGLE_CASE_MODE = 111111 011, then 'o' -> 'O', SHIFT 'o' -> 'o'
    expect(decodeBits(`${HEAD} 111111 011 10 00001 11110 10 00001`).text).toBe('Oo');
  });

  it('rejects SHIFT misuse', () => {
    expect(codeOf(() => decodeBits(`${HEAD} 11110`))).toBe('invalidShift');
    expect(codeOf(() => decodeBits(`${HEAD} 11110 11110`))).toBe('invalidShift');
    expect(codeOf(() => decodeBits(`${HEAD} 11110 10 00000`))).toBe('invalidShift'); // space has no upper case
    expect(codeOf(() => decodeBits(`${HEAD} 11110 110 00011`))).toBe('invalidShift'); // punctuation after SHIFT
  });

  it('rejects TOGGLE_LANGUAGE without Language B', () => {
    expect(codeOf(() => decodeBits(`${HEAD} 111110`))).toBe('toggleWithoutLanguageB');
  });

  it('toggles between two languages', () => {
    // A en, B ru (001); toggle (111110), ru primary id 0 (space), ru primary id 2 ('у')
    const r = decodeBits('001 000 000 001 111110 10 00010');
    expect(r.languageB).toBe('ru');
    expect(r.text).toBe('м');
  });

  it('reads escaped version and generation fields', () => {
    // version 7 + 0 = 7 -> unknownVersion
    expect(codeOf(() => decodeBits('111 00000000 000 000 111'))).toBe('unknownVersion');
    // generation 7 + 3 -> unsupportedModelGeneration (tables needed, header ok)
    expect(codeOf(() => decodeBits('001 111 00000011 000 111'))).toBe('unsupportedModelGeneration');
    expect(codeOf(() => decodeBits('001 001 000 111'))).toBe('unsupportedModelGeneration');
  });

  it('handles the extended header: format 0, reserved 2-7, raw UTF-8', () => {
    // A=7, format 0, A global 1 (ru), B global 255 (none)
    expect(decodeBits('001 000 111 000 00000001 11111111').languageA).toBe('ru');
    for (const format of ['010', '011', '100', '101', '110', '111']) {
      expect(codeOf(() => decodeBits(`001 000 111 ${format}`))).toBe('unsupportedExtendedHeader');
    }
    // A cannot be NONE; unknown global id
    expect(codeOf(() => decodeBits('001 000 111 000 11111111 00000000'))).toBe('unknownLanguage');
    expect(codeOf(() => decodeBits('001 000 111 000 00000111 11111111'))).toBe('unknownLanguage');
    // raw UTF-8 "hi": padding 0000 then bytes
    expect(decodeBits('001 000 111 001 0000 01101000 01101001')).toMatchObject({ text: 'hi', mode: 'rawUtf8' });
    expect(codeOf(() => decodeBits('001 000 111 001 0001'))).toBe('invalidRawUtf8');
    expect(codeOf(() => decodeBits('001 000 111 001 0000 11111111'))).toBe('invalidRawUtf8');
    expect(codeOf(() => decodeBits('001 000 111 001 0000 0110100'))).toBe('invalidRawUtf8');
  });

  it('handles UTF8_RUN and its errors', () => {
    // extended control 111111, subopcode 010, length-1 = 1 (2 bytes), 'é' = c3 a9
    expect(decodeBits(`${HEAD} 111111 010 00001 11000011 10101001`).text).toBe('é');
    expect(codeOf(() => decodeBits(`${HEAD} 111111 010 00000 11111111`))).toBe('invalidUtf8Fallback');
    expect(codeOf(() => decodeBits(`${HEAD} 111111 010 00001 11000011`))).toBe('unexpectedEnd');
  });

  it('rejects unknown extended controls and bad ids', () => {
    expect(codeOf(() => decodeBits(`${HEAD} 111111 100`))).toBe('unknownExtendedControl');
    expect(codeOf(() => decodeBits(`${HEAD} 111111 000 11111111`))).toBe('invalidOtherLanguage');
    expect(codeOf(() => decodeBits(`${HEAD} 111111 000 00000111`))).toBe('invalidOtherLanguage');
    expect(codeOf(() => decodeBits(`${HEAD} 1110 00101`))).toBe('invalidExtensionId'); // en has 5 extension symbols
    expect(decodeBits(`${HEAD} 1110 00100`).text).toBe('0');
  });

  it('rejects a bitLength beyond the data and a truncated stream', () => {
    expect(codeOf(() => decodeMcotxtStream(new Uint8Array(1), 9))).toBe('invalidInput');
    expect(codeOf(() => decodeBits('001 000'))).toBe('unexpectedEnd');
    expect(codeOf(() => decodeBits(`${HEAD} 1`))).toBe('unexpectedEnd');
  });

  it('flags the codes the v4 codec treats as unsupported', () => {
    expect([...MCOTXT_UNSUPPORTED_CODES].sort()).toEqual(['modelUnavailable', 'unknownVersion', 'unsupportedModelGeneration']);
  });
});
