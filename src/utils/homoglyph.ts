/**
 * Homoglyph optimization for Meshtastic messages.
 *
 * Replaces visually identical Cyrillic (and other non-Latin) characters with their
 * Latin equivalents to reduce message size. Cyrillic characters use 2 bytes in UTF-8
 * vs 1 byte for Latin, saving ~20-25% on mixed-script messages.
 *
 * Mapping ported from the Meshtastic Android app (PR #4491).
 */

const HOMOGLYPH_MAP: Record<string, string> = {
  // Uppercase Cyrillic → Latin
  '\u0405': 'S',  // Ѕ → S
  '\u0406': 'I',  // І → I
  '\u0408': 'J',  // Ј → J
  '\u0410': 'A',  // А → A
  '\u0412': 'B',  // В → B
  '\u0415': 'E',  // Е → E
  '\u041A': 'K',  // К → K
  '\u041C': 'M',  // М → M
  '\u041D': 'H',  // Н → H
  '\u041E': 'O',  // О → O
  '\u0420': 'P',  // Р → P
  '\u0421': 'C',  // С → C
  '\u0422': 'T',  // Т → T
  '\u0425': 'X',  // Х → X
  '\u04AE': 'Y',  // Ү → Y
  '\u0417': '3',  // З → 3

  // Lowercase Cyrillic → Latin
  '\u0430': 'a',  // а → a
  '\u0435': 'e',  // е → e
  '\u043E': 'o',  // о → o
  '\u0440': 'p',  // р → p
  '\u0441': 'c',  // с → c
  '\u0443': 'y',  // у → y
  '\u0445': 'x',  // х → x
  '\u0455': 's',  // ѕ → s
  '\u0456': 'i',  // і → i
  '\u0458': 'j',  // ј → j
};

// Build regex from all keys
const HOMOGLYPH_REGEX = new RegExp(
  Object.keys(HOMOGLYPH_MAP).join('|'),
  'g'
);

/**
 * Replace visually identical non-Latin characters with Latin equivalents.
 * This reduces UTF-8 byte size without changing the visual appearance of the text.
 */
export function applyHomoglyphOptimization(text: string): string {
  return text.replace(HOMOGLYPH_REGEX, (char) => HOMOGLYPH_MAP[char] || char);
}
