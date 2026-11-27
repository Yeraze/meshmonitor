/**
 * IM4 text metrics and line layout.
 *
 * Ported from https://github.com/HDDen/meshcore-open (tag 9.5.1-mod-1.9.0)
 *   commit fe375741226588440e268002b4975349b2e95ffe
 *   file   lib/widgets/mco_image_v4_view.dart, lines 16-105 (MCOImageV4TextRendering)
 *
 * Drawing calls mirror the upstream painter; text is laid out by MeshMonitor
 * code (see textLayout.ts), because a canvas has no paragraph engine.
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

import type { V4TextAlign } from './model.js';

/** Inter's capital height in em; only a fallback when the canvas cannot measure one. */
export const V4_TEXT_CAP_HEIGHT_EM = 0.727;
export const V4_TEXT_DESCENT_EM = 0.241;

/**
 * Height of one line box in whole cells: a cap height plus two descenders, so
 * a descender always fits under the baseline.
 */
export function lineBoxCells(fontSize: number): number {
  return Math.ceil(fontSize * (V4_TEXT_CAP_HEIGHT_EM + 2 * V4_TEXT_DESCENT_EM));
}

export interface V4TextLine {
  readonly text: string;
  readonly width: number;
  /** Offset from the area's left edge, after alignment. */
  readonly x: number;
}

function breakWord(word: string, areaWidth: number, measure: (s: string) => number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (cur !== '' && measure(cur + ch) > areaWidth) {
      chunks.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  chunks.push(cur);
  return chunks;
}

function wrapParagraph(
  paragraph: string,
  areaWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of paragraph.split(' ')) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (measure(candidate) <= areaWidth) {
      cur = candidate;
      continue;
    }
    if (cur !== '') lines.push(cur);
    if (measure(word) <= areaWidth) {
      cur = word;
    } else {
      const chunks = breakWord(word, areaWidth, measure);
      cur = chunks.pop() ?? '';
      lines.push(...chunks);
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * Pure. An explicit newline starts a paragraph; lines wrap greedily at spaces;
 * a word wider than the area breaks by code point; trailing spaces do not
 * count; empty text is one empty line.
 */
export function layoutV4Text(
  text: string,
  areaWidth: number,
  align: V4TextAlign,
  measure: (s: string) => number,
): V4TextLine[] {
  const out: V4TextLine[] = [];
  for (const paragraph of text.split('\n')) {
    for (const raw of wrapParagraph(paragraph, areaWidth, measure)) {
      const line = raw.replace(/ +$/, '');
      const width = line === '' ? 0 : measure(line);
      const free = areaWidth - width;
      const x = align === 'center' ? free / 2 : align === 'right' ? free : 0;
      out.push({ text: line, width, x });
    }
  }
  return out;
}
