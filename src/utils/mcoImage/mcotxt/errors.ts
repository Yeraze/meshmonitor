/**
 * MCOtxt codec error type.
 *
 * Ported from https://github.com/HDDen/meshcore-open tag 9.5.1-mod-1.9.0 commit fe375741226588440e268002b4975349b2e95ffe
 *  file   lib/MCOtxt/mcotxt_errors.dart, lines 1-29 (MCOtxtCodecError, MCOtxtCodecException)
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

export type McotxtErrorCode =
  | 'invalidInput'
  | 'unknownVersion'
  | 'unknownLanguage'
  | 'modelUnavailable'
  | 'unsupportedModelGeneration'
  | 'unexpectedEnd'
  | 'invalidTop4Reference'
  | 'invalidPrimaryId'
  | 'invalidExtensionId'
  | 'invalidPunctuationId'
  | 'toggleWithoutLanguageB'
  | 'invalidShift'
  | 'unknownExtendedControl'
  | 'invalidOtherLanguage'
  | 'invalidUtf8Fallback'
  | 'invalidRawUtf8'
  | 'unsupportedExtendedHeader';

export class McotxtCodecError extends Error {
  readonly code: McotxtErrorCode;

  constructor(code: McotxtErrorCode, message: string) {
    super(message);
    this.name = 'McotxtCodecError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Codes the v4 codec maps to "unsupported" (mcoimg_v4_codec.dart lines 2631-2634). */
export const MCOTXT_UNSUPPORTED_CODES: ReadonlySet<McotxtErrorCode> = new Set<McotxtErrorCode>([
  'unknownVersion',
  'unsupportedModelGeneration',
  'modelUnavailable',
]);
