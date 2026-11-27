/**
 * TypeScript port of the MCOtxt v1 decoder (decode only).
 *
 * Ported from https://github.com/HDDen/meshcore-open tag 9.5.1-mod-1.9.0 commit fe375741226588440e268002b4975349b2e95ffe
 *  file   lib/MCOtxt/mcotxt_codec.dart, lines 178-398 (decode), 619-683 (_readHeader), 702-717 (header field, model set),
 *         719-757 (_readRawUtf8Payload, _decodeStrictUtf8), 804-808 (_readTop4Rank), 916-929 (_contextAfterPunctuationRune)
 *  file   lib/MCOtxt/models/mcotxt_model.dart, lines 99-210 (top4ForContext) and mcotxt_model_registry.dart (header ids)
 * Cross-checked against https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a, docs/mcotxt/assets/mcotxt.js, lines 322-398 (decodeStream)
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
import { McotxtBitReader } from './bitReader.js';
import { McotxtCodecError } from './errors.js';
import { MCOTXT_GEN0_MODELS, MCOTXT_GENERATIONS, MCOTXT_LANGUAGE_CODES, MCOTXT_PUNCTUATION } from './tables.js';
import type { McotxtLanguageCode, McotxtModel } from './tables.js';

export interface McotxtDecodeResult {
  readonly text: string;
  readonly mode: 'mcotxt' | 'rawUtf8';
  readonly modelGeneration: number;
  readonly languageA: string | null;
  readonly languageB: string | null;
}

const VERSION = 1;
const HEADER_FIELD_BITS = 3;
const HEADER_FIELD_ESCAPE = 7;
const HEADER_FIELD_ESCAPE_BITS = 8;
const LANGUAGE_BITS = 3;
const RAW_UTF8_PADDING_BITS = 4;
const PRIMARY_LIMIT = 32;
const EXTENSION_LIMIT = 32;
const UTF8_RUN_LENGTH_BITS = 5;
const LANGUAGE_NONE_WIRE_ID = 7;
const EXTENDED_LANGUAGE_HEADER_WIRE_ID = 7;
const EXTENDED_LANGUAGE_PAIR8_FORMAT = 0;
const RAW_UTF8_HEADER_FORMAT = 1;
const GLOBAL_LANGUAGE_NONE_ID = 255;
const SPACE = 0x20;
const LINE_FEED = 0x0a;

const SWITCH_OTHER_LANGUAGE_SUBOPCODE = 0;
const RESET_CONTEXT_SUBOPCODE = 1;
const UTF8_RUN_SUBOPCODE = 2;
const TOGGLE_CASE_MODE_SUBOPCODE = 3;

type ContextKind = 'start' | 'afterPunctuation' | 'symbol';

interface Header {
  readonly mode: 'mcotxt' | 'rawUtf8';
  readonly languageA: number | null;
  readonly languageB: number | null;
}

/** MCOtxtLanguageId.fromWireId: 0..6 are languages, 7 and above are none. */
function languageFromId(value: number): number | null {
  return value >= 0 && value < MCOTXT_LANGUAGE_CODES.length ? value : null;
}

function readHeaderField(reader: McotxtBitReader): number {
  const inline = reader.readBits(HEADER_FIELD_BITS);
  if (inline !== HEADER_FIELD_ESCAPE) return inline;
  return HEADER_FIELD_ESCAPE + reader.readBits(HEADER_FIELD_ESCAPE_BITS);
}

function readHeader(reader: McotxtBitReader): Header {
  const languageAInline = reader.readBits(LANGUAGE_BITS);
  const languageBInlineOrFormat = reader.readBits(LANGUAGE_BITS);
  if (languageAInline !== EXTENDED_LANGUAGE_HEADER_WIRE_ID) {
    const languageA = languageFromId(languageAInline);
    if (languageA === null) {
      throw new McotxtCodecError('unknownLanguage', 'Invalid MCOtxt Language A');
    }
    const languageB = languageFromId(languageBInlineOrFormat);
    if (languageBInlineOrFormat !== LANGUAGE_NONE_WIRE_ID && languageB === null) {
      throw new McotxtCodecError('unknownLanguage', 'Invalid MCOtxt Language B');
    }
    return { mode: 'mcotxt', languageA, languageB };
  }

  if (languageBInlineOrFormat === RAW_UTF8_HEADER_FORMAT) {
    return { mode: 'rawUtf8', languageA: null, languageB: null };
  }

  if (languageBInlineOrFormat !== EXTENDED_LANGUAGE_PAIR8_FORMAT) {
    throw new McotxtCodecError('unsupportedExtendedHeader', 'Unsupported MCOtxt extended language header');
  }

  const languageAGlobal = reader.readBits(8);
  const languageBGlobal = reader.readBits(8);
  if (languageAGlobal === GLOBAL_LANGUAGE_NONE_ID) {
    throw new McotxtCodecError('unknownLanguage', 'MCOtxt extended Language A cannot be NONE');
  }
  const languageA = languageForGlobalId(languageAGlobal);
  const languageB = languageForGlobalId(languageBGlobal);
  if (languageA === null || (languageBGlobal !== GLOBAL_LANGUAGE_NONE_ID && languageB === null)) {
    throw new McotxtCodecError('unknownLanguage', 'Unknown MCOtxt global language ID');
  }
  return { mode: 'mcotxt', languageA, languageB };
}

function languageForGlobalId(globalId: number): number | null {
  if (globalId === GLOBAL_LANGUAGE_NONE_ID) return null;
  return languageFromId(globalId);
}

function modelSetForGeneration(generation: number): readonly McotxtModel[] {
  if (!MCOTXT_GENERATIONS.has(generation)) {
    throw new McotxtCodecError(
      'unsupportedModelGeneration',
      `MCOtxt model generation ${generation} is not available in this build`,
    );
  }
  return MCOTXT_GEN0_MODELS;
}

function decodeStrictUtf8(bytes: Uint8Array, code: 'invalidRawUtf8' | 'invalidUtf8Fallback', label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new McotxtCodecError(code, `Invalid MCOtxt ${label} bytes: ${reason}`);
  }
}

function readRawUtf8Payload(reader: McotxtBitReader): string {
  const padding = reader.readBits(RAW_UTF8_PADDING_BITS);
  if (padding !== 0) {
    throw new McotxtCodecError('invalidRawUtf8', 'MCOtxt RAW_UTF8 padding bits must be zero');
  }
  if (reader.remainingBits % 8 !== 0) {
    throw new McotxtCodecError('invalidRawUtf8', 'MCOtxt RAW_UTF8 payload must be byte-aligned');
  }
  const bytes = new Uint8Array(Math.floor(reader.remainingBits / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = reader.readBits(8);
  }
  return decodeStrictUtf8(bytes, 'invalidRawUtf8', 'RAW_UTF8');
}

function readTop4Rank(reader: McotxtBitReader): number {
  if (reader.readBit() === 0) return 0;
  if (reader.readBit() === 0) return 1;
  return reader.readBit() === 0 ? 2 : 3;
}

function top4ForContext(model: McotxtModel, kind: ContextKind, previousRune: number | null): readonly number[] {
  if (kind === 'start') return model.start;
  if (kind === 'afterPunctuation') return model.afterPunct;
  if (previousRune === null) return [];
  const index = model.indexes.get(previousRune);
  if (index === undefined) return [];
  const row = model.rows[index];
  return row === undefined ? [] : row;
}

/** Assemble code points into a string in chunks (no spread over a huge array). */
function stringFromRunes(runes: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < runes.length; i += 4096) {
    parts.push(String.fromCodePoint(...runes.slice(i, i + 4096)));
  }
  return parts.join('');
}

/** Throws McotxtCodecError. `bitLength` is exact (never inferred from data.length). */
export function decodeMcotxtStream(data: Uint8Array, bitLength: number): McotxtDecodeResult {
  const reader = new McotxtBitReader(data, bitLength);
  const receivedVersion = readHeaderField(reader);
  if (receivedVersion !== VERSION) {
    throw new McotxtCodecError('unknownVersion', `Unsupported MCOtxt version ${receivedVersion}`);
  }
  const generation = readHeaderField(reader);
  const header = readHeader(reader);
  if (header.mode === 'rawUtf8') {
    // RAW_UTF8 uses no tables, so the generation is reported as read
    // and a stream from a newer generation still decodes.
    const text = readRawUtf8Payload(reader);
    return { text, mode: 'rawUtf8', modelGeneration: generation, languageA: null, languageB: null };
  }
  const models = modelSetForGeneration(generation);
  const languageA = header.languageA;
  const languageB = header.languageB;
  if (languageA === null || models[languageA] === undefined || (languageB !== null && models[languageB] === undefined)) {
    throw new McotxtCodecError(
      'modelUnavailable',
      'MCOtxt payload requires a language model unavailable in this build',
    );
  }
  let currentLanguage: number = languageA;
  let contextKind = 'start' as ContextKind;
  let previousRune = null as number | null;
  let shift = false;
  let capsMode = false;
  const output: number[] = [];

  const currentModel = (): McotxtModel => {
    const model = models[currentLanguage];
    if (model === undefined) {
      throw new McotxtCodecError('unknownLanguage', 'Language token without active MCOtxt language');
    }
    return model;
  };

  const emitLanguageRune = (model: McotxtModel, rune: number): void => {
    const uppercaseRune = model.lowerToUpper.get(rune);
    if (shift && uppercaseRune === undefined) {
      throw new McotxtCodecError('invalidShift', 'MCOtxt SHIFT cannot be applied to this symbol');
    }

    // SHIFT is a one-symbol case inversion. With CAPS_MODE disabled this is
    // the original v1 behavior (SHIFT -> uppercase). With CAPS_MODE enabled
    // the default for caseable symbols is uppercase and SHIFT emits one
    // lowercase symbol. Non-caseable symbols (digits/SPACE/etc.) are
    // unaffected by CAPS_MODE.
    const makeUppercase = uppercaseRune !== undefined && capsMode !== shift;
    output.push(makeUppercase ? uppercaseRune : rune);
    contextKind = 'symbol';
    previousRune = rune;
    shift = false;
  };

  const assertNoPendingShiftBeforeControl = (): void => {
    if (!shift) return;
    throw new McotxtCodecError('invalidShift', 'MCOtxt SHIFT must be followed by a language symbol');
  };

  while (reader.remainingBits > 0) {
    if (reader.readBit() === 0) {
      const rank = readTop4Rank(reader);
      const model = currentModel();
      const predictions = top4ForContext(model, contextKind, previousRune);
      if (rank >= predictions.length) {
        throw new McotxtCodecError('invalidTop4Reference', 'Invalid MCOtxt TOP4 reference');
      }
      emitLanguageRune(model, predictions[rank] as number);
      continue;
    }
    if (reader.readBit() === 0) {
      const primaryId = reader.readBits(5);
      const model = currentModel();
      if (primaryId >= PRIMARY_LIMIT || primaryId >= model.primary.length) {
        throw new McotxtCodecError('invalidPrimaryId', 'Invalid MCOtxt primary literal');
      }
      emitLanguageRune(model, model.primary[primaryId] as number);
      continue;
    }
    if (reader.readBit() === 0) {
      assertNoPendingShiftBeforeControl();
      const punctuationId = reader.readBits(5);
      if (punctuationId >= MCOTXT_PUNCTUATION.length) {
        throw new McotxtCodecError('invalidPunctuationId', 'Invalid MCOtxt punctuation literal');
      }
      const rune = MCOTXT_PUNCTUATION[punctuationId] as number;
      output.push(rune);
      if (rune === SPACE) {
        if (contextKind === 'symbol') {
          // keeps the symbol context and its previous rune
        } else {
          contextKind = 'start';
          previousRune = null;
        }
      } else if (rune === LINE_FEED) {
        contextKind = 'start';
        previousRune = null;
      } else {
        contextKind = 'afterPunctuation';
        previousRune = null;
      }
      continue;
    }
    if (reader.readBit() === 0) {
      const extensionId = reader.readBits(5);
      const model = currentModel();
      if (extensionId >= EXTENSION_LIMIT || extensionId >= model.extension.length) {
        throw new McotxtCodecError('invalidExtensionId', 'Invalid MCOtxt extension literal');
      }
      emitLanguageRune(model, model.extension[extensionId] as number);
      continue;
    }
    if (reader.readBit() === 0) {
      if (shift) {
        throw new McotxtCodecError('invalidShift', 'Duplicate MCOtxt SHIFT');
      }
      shift = true;
      continue;
    }
    if (reader.readBit() === 0) {
      assertNoPendingShiftBeforeControl();
      if (languageB === null) {
        throw new McotxtCodecError('toggleWithoutLanguageB', 'MCOtxt TOGGLE_LANGUAGE without Language B');
      }
      if (currentLanguage === languageA) {
        currentLanguage = languageB;
      } else if (currentLanguage === languageB) {
        currentLanguage = languageA;
      } else {
        throw new McotxtCodecError('toggleWithoutLanguageB', 'MCOtxt TOGGLE_LANGUAGE outside A/B context');
      }
      previousRune = null;
      contextKind = 'start';
      continue;
    }
    assertNoPendingShiftBeforeControl();
    const subopcode = reader.readBits(3);
    switch (subopcode) {
      case SWITCH_OTHER_LANGUAGE_SUBOPCODE: {
        const globalId = reader.readBits(8);
        const language = languageForGlobalId(globalId);
        if (globalId === GLOBAL_LANGUAGE_NONE_ID || language === null) {
          throw new McotxtCodecError('invalidOtherLanguage', 'Invalid MCOtxt SWITCH_OTHER_LANGUAGE');
        }
        if (models[language] === undefined) {
          throw new McotxtCodecError(
            'modelUnavailable',
            'MCOtxt SWITCH_OTHER_LANGUAGE references an unavailable model',
          );
        }
        currentLanguage = language;
        previousRune = null;
        contextKind = 'start';
        break;
      }
      case RESET_CONTEXT_SUBOPCODE:
        previousRune = null;
        contextKind = 'start';
        break;
      case UTF8_RUN_SUBOPCODE: {
        const length = reader.readBits(UTF8_RUN_LENGTH_BITS) + 1;
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          bytes[i] = reader.readBits(8);
        }
        const text = decodeStrictUtf8(bytes, 'invalidUtf8Fallback', 'UTF8_RUN');
        for (const symbol of text) output.push(symbol.codePointAt(0) as number);
        previousRune = null;
        contextKind = 'start';
        break;
      }
      case TOGGLE_CASE_MODE_SUBOPCODE:
        // Persistent case mode does not alter the prediction context: the
        // statistical model is defined over normalized lowercase symbols.
        capsMode = !capsMode;
        break;
      default:
        throw new McotxtCodecError('unknownExtendedControl', 'Unknown MCOtxt extended control');
    }
  }

  if (shift) {
    throw new McotxtCodecError('invalidShift', 'MCOtxt stream ends after SHIFT');
  }

  return {
    text: stringFromRunes(output),
    mode: 'mcotxt',
    modelGeneration: generation,
    languageA: MCOTXT_LANGUAGE_CODES[languageA] as McotxtLanguageCode,
    languageB: languageB === null ? null : (MCOTXT_LANGUAGE_CODES[languageB] as McotxtLanguageCode),
  };
}
