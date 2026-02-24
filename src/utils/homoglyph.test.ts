import { describe, it, expect } from 'vitest';
import { applyHomoglyphOptimization } from './homoglyph';

describe('applyHomoglyphOptimization', () => {
  it('should replace Cyrillic uppercase homoglyphs with Latin equivalents', () => {
    // Cyrillic А, В, Е, К, М, Н, О, Р, С, Т, Х
    expect(applyHomoglyphOptimization('\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0425')).toBe('ABEKMHOPCТX'.replace('Т', 'T'));
    // More precisely:
    expect(applyHomoglyphOptimization('\u0410')).toBe('A');
    expect(applyHomoglyphOptimization('\u0412')).toBe('B');
    expect(applyHomoglyphOptimization('\u0415')).toBe('E');
    expect(applyHomoglyphOptimization('\u041A')).toBe('K');
    expect(applyHomoglyphOptimization('\u041C')).toBe('M');
    expect(applyHomoglyphOptimization('\u041D')).toBe('H');
    expect(applyHomoglyphOptimization('\u041E')).toBe('O');
    expect(applyHomoglyphOptimization('\u0420')).toBe('P');
    expect(applyHomoglyphOptimization('\u0421')).toBe('C');
    expect(applyHomoglyphOptimization('\u0422')).toBe('T');
    expect(applyHomoglyphOptimization('\u0425')).toBe('X');
  });

  it('should replace Cyrillic lowercase homoglyphs with Latin equivalents', () => {
    expect(applyHomoglyphOptimization('\u0430')).toBe('a');
    expect(applyHomoglyphOptimization('\u0435')).toBe('e');
    expect(applyHomoglyphOptimization('\u043E')).toBe('o');
    expect(applyHomoglyphOptimization('\u0440')).toBe('p');
    expect(applyHomoglyphOptimization('\u0441')).toBe('c');
    expect(applyHomoglyphOptimization('\u0443')).toBe('y');
    expect(applyHomoglyphOptimization('\u0445')).toBe('x');
  });

  it('should replace extended Cyrillic homoglyphs', () => {
    expect(applyHomoglyphOptimization('\u0405')).toBe('S'); // Ѕ
    expect(applyHomoglyphOptimization('\u0406')).toBe('I'); // І
    expect(applyHomoglyphOptimization('\u0408')).toBe('J'); // Ј
    expect(applyHomoglyphOptimization('\u04AE')).toBe('Y'); // Ү
    expect(applyHomoglyphOptimization('\u0417')).toBe('3'); // З
    expect(applyHomoglyphOptimization('\u0455')).toBe('s'); // ѕ
    expect(applyHomoglyphOptimization('\u0456')).toBe('i'); // і
    expect(applyHomoglyphOptimization('\u0458')).toBe('j'); // ј
  });

  it('should not modify Latin characters', () => {
    expect(applyHomoglyphOptimization('Hello World')).toBe('Hello World');
  });

  it('should not modify non-homoglyph Cyrillic characters', () => {
    // Б, Г, Д, Ж, Л, Ф, Ц, Ч, Ш, Щ — these have no Latin look-alikes
    const nonHomoglyphs = '\u0411\u0413\u0414\u0416\u041B\u0424\u0426\u0427\u0428\u0429';
    expect(applyHomoglyphOptimization(nonHomoglyphs)).toBe(nonHomoglyphs);
  });

  it('should handle mixed Latin and Cyrillic text', () => {
    // "Москва" with Cyrillic М, о, с → "Mocква" but only homoglyphs replaced
    const input = '\u041C\u043E\u0441\u043A\u0432\u0430'; // Москва
    const expected = 'Mocк\u0432a'; // M, o, c are Latin; к, в stay Cyrillic; а→a
    expect(applyHomoglyphOptimization(input)).toBe(expected);
  });

  it('should return empty string for empty input', () => {
    expect(applyHomoglyphOptimization('')).toBe('');
  });

  it('should handle text with no replaceable characters', () => {
    expect(applyHomoglyphOptimization('12345!@#$%')).toBe('12345!@#$%');
  });

  it('should reduce UTF-8 byte size for Cyrillic text with homoglyphs', () => {
    // Realistic Cyrillic sentence: "Москва - столица России" (Moscow is the capital of Russia)
    // Contains homoglyphs: М→M, о→o, с→c, а→a, т→(no mapping), р→p, о→o, с→c, с→c, и→(no mapping)
    const input = '\u041C\u043E\u0441\u043A\u0432\u0430 - \u0441\u0442\u043E\u043B\u0438\u0446\u0430 \u0420\u043E\u0441\u0441\u0438\u0438';
    const result = applyHomoglyphOptimization(input);

    const encoder = new TextEncoder();
    const originalBytes = encoder.encode(input).length;
    const optimizedBytes = encoder.encode(result).length;

    // Each replaced Cyrillic char saves 1 byte (2 bytes → 1 byte)
    expect(optimizedBytes).toBeLessThan(originalBytes);
    // Verify the exact savings: М,о,с,а,с,о,а,Р,о,с,с = 11 homoglyphs = 11 bytes saved
    expect(originalBytes - optimizedBytes).toBe(11);
  });

  it('should achieve ~20% byte reduction on homoglyph-heavy Cyrillic text', () => {
    // All-homoglyph uppercase: АВЕКМНОРСТХ (11 chars, all replaceable)
    const input = '\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0425';
    const result = applyHomoglyphOptimization(input);

    const encoder = new TextEncoder();
    const originalBytes = encoder.encode(input).length;   // 22 bytes (11 × 2)
    const optimizedBytes = encoder.encode(result).length;  // 11 bytes (11 × 1)

    const reduction = (originalBytes - optimizedBytes) / originalBytes;
    expect(reduction).toBe(0.5); // 50% reduction for all-homoglyph text
  });

  it('should not change byte size for pure Latin text', () => {
    const input = 'Hello World 123';

    const encoder = new TextEncoder();
    const originalBytes = encoder.encode(input).length;
    const optimizedBytes = encoder.encode(applyHomoglyphOptimization(input)).length;

    expect(optimizedBytes).toBe(originalBytes);
  });
});
