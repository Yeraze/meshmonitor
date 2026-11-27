/**
 * basE91 codec for MCOimg.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 161-236
 *
 * MIT License, Copyright (c) 2025 zjs81. Full licence text: see
 * src/utils/mcoImage/v3/decoder.ts.
 */
import { McoImageV3InvalidPayloadError } from './v3/errors.js';

export const BASE91_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
  '!#$%&()*+,./:;<=>?@[]^_`{|}~"';

const BASE91_DECODE = new Map<number, number>(
  Array.from(BASE91_ALPHABET).map((character, index): [number, number] => [character.charCodeAt(0), index]),
);

export function base91Encode(bytes: Uint8Array): string {
  let output = '';
  let queue = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    queue |= byte << bitCount;
    bitCount += 8;
    if (bitCount > 13) {
      let value = queue & 8191;
      if (value > 88) {
        queue >>>= 13;
        bitCount -= 13;
      } else {
        value = queue & 16383;
        queue >>>= 14;
        bitCount -= 14;
      }
      output += BASE91_ALPHABET[value % 91];
      output += BASE91_ALPHABET[Math.floor(value / 91)];
    }
  }
  if (bitCount > 0) {
    output += BASE91_ALPHABET[queue % 91];
    if (bitCount > 7 || queue > 90) {
      output += BASE91_ALPHABET[Math.floor(queue / 91)];
    }
  }
  return output;
}

export function base91Decode(text: string): Uint8Array {
  const output: number[] = [];
  let value = -1;
  let queue = 0;
  let bitCount = 0;
  for (let i = 0; i < text.length; i++) {
    const decoded = BASE91_DECODE.get(text.charCodeAt(i));
    if (decoded === undefined) {
      throw new McoImageV3InvalidPayloadError('Invalid basE91 character');
    }
    if (value < 0) {
      value = decoded;
    } else {
      value += decoded * 91;
      queue |= value << bitCount;
      bitCount += (value & 8191) > 88 ? 13 : 14;
      while (bitCount > 7) {
        output.push(queue & 0xff);
        queue >>>= 8;
        bitCount -= 8;
      }
      value = -1;
    }
  }
  if (value >= 0) output.push((queue | (value << bitCount)) & 0xff);
  return Uint8Array.from(output);
}
