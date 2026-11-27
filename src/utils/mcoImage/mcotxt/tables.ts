/**
 * MCOtxt v1 generation-0 language tables.
 *
 * Language codes and punctuation page from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcotxt/assets/mcotxt.js, lines 10-15 (LANGUAGE_CODES, PUNCT)
 * Generation-0 model tables copied verbatim from the same file, lines 143-248
 *   (makeModel and the seven makeModel(...) calls); the same tables, hash-checked, are in
 *   https://github.com/HDDen/meshcore-open tag 9.5.1-mod-1.9.0 commit fe375741226588440e268002b4975349b2e95ffe
 *   lib/MCOtxt/models/generated/v1/model_*.dart and lib/MCOtxt/models/mcotxt_model.dart
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file; only types were added.
 *
 * MIT License
 *
 * Copyright (c) 2025 zjs81
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { McotxtCodecError } from './errors.js';

export const MCOTXT_LANGUAGE_CODES = ['en', 'ru', 'fr', 'de', 'it', 'uk', 'be'] as const;
export type McotxtLanguageCode = (typeof MCOTXT_LANGUAGE_CODES)[number];

/** Wire order of the shared punctuation page (mcotxt.js PUNCT, Dart MCOtxtPunctuation.symbols). */
export const MCOTXT_PUNCTUATION: readonly number[] = [32, 46, 44, 33, 63, 58, 59, 45, 8212, 95, 39, 34, 171, 187,
  8220, 8221, 8222, 8216, 8217, 40, 41, 91, 93, 47, 92, 64, 35, 37, 38, 43, 61, 10];

export interface McotxtModel {
  readonly id: number;
  readonly hash: string;
  readonly primary: readonly number[];
  readonly extension: readonly number[];
  /** primary ++ extension */
  readonly symbols: readonly number[];
  readonly indexes: ReadonlyMap<number, number>;
  readonly lowerToUpper: ReadonlyMap<number, number>;
  readonly start: readonly number[];
  readonly afterPunct: readonly number[];
  readonly rows: readonly (readonly number[])[];
  /** Raw literals, kept for the wire-hash test. */
  readonly source: {
    readonly primary: string;
    readonly extension: string;
    readonly upper: string;
    readonly lower: string;
    readonly start: readonly number[];
    readonly afterPunct: readonly number[];
    readonly rows: readonly number[];
  };
}

const codePoints = (text: string): number[] => Array.from(text, (symbol) => symbol.codePointAt(0) as number);

function fail(message: string): never {
  throw new McotxtCodecError('invalidInput', message);
}

// Frozen generation-0 tables, moved from model_<lang>.dart.
// TOP4 indexes refer to primary + extension; the order must not change.
function makeModel(
  id: number,
  hash: string,
  primary: string,
  extension: string,
  upper: string,
  lower: string,
  start: readonly number[],
  afterPunct: readonly number[],
  rows: readonly number[],
): McotxtModel {
  const symbols = codePoints(primary + extension);
  const upperRunes = codePoints(upper);
  const lowerRunes = codePoints(lower);
  if (rows.length !== symbols.length * 4 || upperRunes.length !== lowerRunes.length) {
    fail('Invalid embedded model ' + MCOTXT_LANGUAGE_CODES[id]);
  }
  const resolved = (index: number): number => {
    const rune = symbols[index];
    if (rune === undefined) fail('Invalid TOP4 row');
    return rune;
  };
  const tableRows: number[][] = [];
  for (let i = 0; i < rows.length; i += 4) {
    const row = rows.slice(i, i + 4).map(resolved);
    if (new Set(row).size !== 4) {
      fail('Invalid TOP4 row');
    }
    tableRows.push(row);
  }
  return {
    id,
    hash,
    symbols,
    primary: codePoints(primary),
    extension: codePoints(extension),
    indexes: new Map(symbols.map((rune, index) => [rune, index])),
    lowerToUpper: new Map(lowerRunes.map((rune, index) => [rune, upperRunes[index] as number])),
    start: start.map(resolved),
    afterPunct: afterPunct.map(resolved),
    rows: tableRows,
    source: { primary, extension, upper, lower, start, afterPunct, rows },
  };
}

/** Index = language id 0..6. */
export const MCOTXT_GEN0_MODELS: readonly McotxtModel[] = [
    makeModel(0, '55988b3bb2a000adf6e768a8541df5a25fec1628b4ec661a10b577e3af8b3770',
      ' odailrmytcpwsfghbnekuvx1j3284z5', 'q6790',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', [16,7,9,4], [0,13,9,7], [
        9,3,4,13,18,6,0,21,0,1,19,3,18,9,5,0,18,9,13,0,5,1,0,19,19,0,18,1,19,
        1,0,3,0,1,19,13,0,16,1,19,1,16,3,19,19,13,0,1,19,4,3,0,0,9,19,16,0,1,
        6,4,0,1,16,19,19,3,1,4,19,21,1,3,15,0,4,19,0,6,13,18,19,0,13,4,9,13,
        0,6,19,4,29,3,0,9,11,4,36,0,31,27,21,1,3,19,0,36,33,2,0,27,31,36,0,7,
        33,36,0,36,29,33,19,30,8,4,0,36,33,27,21,0,7,9,0,36,35,28,0,5,10,6,0,
        33,2,35,0,36,7,35
      ]),
    makeModel(1, 'd123c4978a635bf1b26fe37261b7e96a0206b3ba15b2a80542e560f00d1eb193',
      ' смуркелниятбдвгчазоыпйхжшюьэщцф', '123ё4587690ъ',
      'ЁАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'ёабвгдежзийклмнопрстуфхцчшщъыьэюя', [21,8,0,13], [0,11,32,5], [
        8,21,1,14,11,6,0,19,0,6,19,17,0,11,13,24,19,17,6,9,19,17,0,9,0,11,8,4,
        9,27,19,6,17,19,6,9,0,11,8,7,0,11,18,7,19,17,0,27,19,4,20,6,17,19,6,9,
        0,6,17,19,19,13,17,9,6,11,17,9,0,7,5,11,17,0,8,9,0,11,13,14,0,22,25,7,
        19,4,9,17,0,11,16,5,19,0,17,3,6,8,13,9,6,9,17,5,0,11,16,1,0,8,5,1,11,
        5,8,7,6,17,35,9,9,6,17,0,9,19,7,6,0,42,32,36,0,42,37,33,0,42,34,33,0,
        11,2,7,0,42,34,37,0,42,37,40,0,40,42,33,0,39,42,37,0,37,38,42,0,41,42,
        37,0,42,2,5,6,10,35,9
      ]),
    makeModel(2, '910c5821a202a9b35313a9b939355f09d1c4293fe2ed246fed0123639d379ccb',
      ' utcmrloieasnvpéjbdghfqyçàk2x15z', '4w376è08ê9ôîùûüëœâæïÿ',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÆÇÈÉÊËÎÏÔÙÛÜŒŸ', 'abcdefghijklmnopqrstuvwxyzàâæçèéêëîïôùûüœÿ', [17,11,2,3], [0,10,9,12], [
        18,14,6,11,5,0,2,8,0,9,8,7,7,20,9,10,9,10,7,8,0,9,10,7,9,10,6,0,12,
        1,8,5,0,11,12,5,0,11,12,5,8,0,12,11,0,2,9,10,0,2,9,11,9,7,8,10,10,7,
        9,5,2,0,9,14,9,7,1,10,7,8,6,9,9,8,0,1,9,5,10,12,9,7,10,0,10,5,8,7,
        1,0,22,5,0,9,7,2,10,1,7,0,0,9,11,10,0,9,10,8,0,38,29,41,0,9,2,7,0,
        34,29,35,0,38,41,27,0,10,9,8,0,41,32,34,8,9,10,7,0,34,32,39,34,29,38,0,
        0,39,27,32,11,5,2,4,0,38,36,35,0,36,4,21,2,4,13,0,0,10,21,9,2,6,14,0,
        12,2,6,3,0,9,11,10,5,0,9,11,5,0,9,11,6,0,9,11,8,0,9,11,0,9,11,10,0,
        9,11,10,0,9,11,10,0,9,11,10
      ]),
    makeModel(3, '00b971288fee56f37535ce03b4ac0d8ebddfc12ecbd5ef282ab4b0f4a659f451',
      ' stbhoglimnruwkfecadzpüvjöä132y5', '94678ßx0q',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜẞ', 'abcdefghijklmnopqrstuvwxyzäöüß', [6,9,4,19], [0,3,19,18], [
        18,19,9,8,0,2,16,17,0,16,18,2,16,8,18,0,0,18,16,2,11,8,10,21,16,12,11,
        0,7,16,8,0,10,17,16,2,5,16,8,18,0,19,16,18,0,16,6,18,1,2,10,11,16,8,
        18,5,16,5,18,0,16,18,0,11,10,11,0,8,4,14,5,0,12,10,7,17,16,18,0,8,12,
        16,2,0,1,16,21,15,37,11,3,17,5,16,8,12,16,18,5,12,10,11,7,6,2,26,12,10,
        0,39,27,29,0,27,39,36,0,39,35,28,2,0,16,5,0,39,4,35,0,4,39,36,0,35,39,
        34,0,27,28,34,0,28,27,33,0,27,28,34,16,0,2,8,0,8,2,16,0,39,34,35,12,0,
        2,1
      ]),
    makeModel(4, 'f6d073a1d6ae6344eaac445b86fb8a454b276a740fd40651956b1ff28f5af270',
      ' tlmpuircsgveoandbhzfqè1324wk768', '5yàì9ò0ùjéxíóú',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÈÉÌÍÒÓÙÚ', 'abcdefghijklmnopqrstuvwxyzàèéìíòóùú', [17,8,9,6], [0,6,14,7], [
        14,9,16,8,12,6,13,1,14,0,12,6,12,6,14,13,12,13,9,7,13,15,1,14,0,13,14,
        15,12,14,6,13,13,6,18,12,12,14,1,6,6,10,7,14,12,14,13,6,0,7,15,9,0,15,
        7,4,0,15,2,7,13,0,14,1,14,6,13,12,5,12,6,14,13,12,6,14,6,14,19,13,14,
        6,12,13,5,1,0,7,0,13,14,6,0,38,25,14,0,17,24,18,0,38,31,36,0,36,32,18,
        6,14,0,12,0,6,7,5,24,0,20,32,0,23,31,32,0,30,17,20,0,38,23,30,1,0,10,
        9,0,13,14,6,0,14,15,13,0,13,23,25,0,12,13,14,0,38,25,30,0,13,14,6,15,
        13,0,14,0,13,14,6,0,8,5,16,0,13,14,6,0,13,14,6,0,13,14,6
      ]),
    makeModel(5, '949992c57156526843cdb9634c5c14bee23218878f116ef90be2a8497274c131',
      ' ксрімунзблдоияаетвшчйгпжюцхєщфї', '23ь14586709ґ',
      'ЄІЇАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЬЮЯҐ', 'єіїабвгдежзийклмнопрстуфхцчшщьюяґ', [0,17,7,11], [0,37,41,35], [
        23,18,7,17,12,15,13,6,17,34,14,23,12,15,16,13,0,11,7,10,12,15,0,16,0,18,
        17,10,15,12,16,4,15,0,7,4,6,15,12,4,16,34,13,14,12,15,16,6,0,5,18,11,0,
        18,17,2,0,1,17,18,0,7,17,10,0,7,3,5,15,13,12,34,0,15,13,4,13,12,16,6,
        13,15,16,12,0,7,17,12,12,15,4,3,3,12,4,16,16,7,0,13,0,28,17,18,16,4,25,
        14,0,12,13,17,0,17,5,11,12,16,15,6,4,12,15,17,0,27,31,7,0,32,39,41,0,
        32,33,41,0,7,1,2,32,41,0,37,0,33,40,41,0,18,41,32,41,0,39,32,38,0,32,
        33,0,41,1,5,0,41,1,5,39,0,42,22,0,12,15,7
      ]),
    makeModel(6, 'dd23c2b82288e0a4452f237ccd905055974779e3cc5cc6f3d03be1b24e5bb1fd',
      ' клмсервнядутчопзыйгбжашюхьэ2фц1', '4ё3685709іў',
      'ЁІЎАБВГДЕЖЗЙКЛМНОПРСТУФХЦЧШЫЬЭЮЯ', 'ёіўабвгдежзйклмнопрстуфхцчшыьэюя', [0,12,8,5], [0,12,28,38], [
        8,15,7,4,22,14,0,2,14,26,0,22,14,0,5,22,12,0,5,14,0,12,8,6,14,22,5,11,
        0,22,5,14,22,14,5,11,0,12,16,8,5,14,22,11,0,12,21,4,14,22,0,26,5,22,12,
        8,0,10,20,12,14,6,22,5,22,0,8,14,0,18,2,12,0,12,1,4,14,6,10,22,14,17,
        11,6,5,8,11,22,0,2,4,12,5,26,22,12,13,0,12,10,14,0,22,16,0,8,23,12,12,
        1,29,7,0,28,39,32,14,22,29,11,5,22,7,17,39,37,0,31,0,37,36,39,0,12,3,
        14,0,39,28,32,0,36,38,40,35,0,37,14,0,39,35,4,0,35,28,37,39,0,28,37,39,
        0,3,34,0,14,5,22,0,14,5,22
      ])
];

export const MCOTXT_GENERATIONS: ReadonlySet<number> = new Set([0]);
