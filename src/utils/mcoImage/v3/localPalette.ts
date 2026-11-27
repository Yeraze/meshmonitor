/**
 * TypeScript port of the MCOimg v3 (IM3) decoder.
 *
 * Ported from https://github.com/HDDen/meshcore-open (branch rename-mco-advanced)
 *   commit c38c1650fe8394835e333b5b4a1ac84ead2d5e5a
 *   file   docs/mcoimg-js/mcoimg-v3-codec.global.js, lines 664-865 (local palette readers)
 *
 * Logic, function names, order, checks and error messages follow the upstream
 * file line for line; only types were added.
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
import { LOCAL_PALETTE_BANK_DESCRIPTOR_BITMAPS, LOCAL_PALETTE_BANK_DESCRIPTOR_ORDERED_8X64, LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS, LOCAL_PALETTE_DESCRIPTOR_BITMAP, LOCAL_PALETTE_DESCRIPTOR_BITS, LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS, LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA, LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT, LOCAL_PALETTE_SMALL_LENGTH_LIMIT, PaletteProfile } from './constants.js';
import type { PaletteProfileId } from './constants.js';
import { McoImageV3InvalidPayloadError } from './errors.js';
import { globalBits, globalIndexForProfileRef, paletteSize } from './palettes.js';
import { BitReader, bitCount, bitLength } from './bitReader.js';
import { readColorRef } from './readers.js';

export function readLocalPalettePrefix(reader: BitReader, profile: PaletteProfileId) {
  const size = paletteSize(profile);
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) {
    if (reader.readBits(1) !== 0) {
      return { descriptor: reader.readBits(LOCAL_PALETTE_DESCRIPTOR_BITS) };
    }
    return { length: reader.readBits(globalBits(profile)) + 1 };
  }
  if (reader.readBits(1) === 0) return { length: reader.readBits(6) + 1 };
  if (reader.readBits(1) === 0) return { length: reader.readBits(6) + 65 };
  if (reader.readBits(1) === 0) {
    const length = reader.readBits(8) + 129;
    if (length > size) throw new McoImageV3InvalidPayloadError('Invalid local palette size');
    return { length };
  }
  if (reader.readBits(1) === 0) {
    const length = reader.readBits(7) + 385;
    if (length > size) throw new McoImageV3InvalidPayloadError('Invalid local palette size');
    return { length };
  }
  return { descriptor: reader.readBits(LOCAL_PALETTE_DESCRIPTOR_BITS) };
}

export function readLocalPaletteLength(reader: BitReader, profile: PaletteProfileId) {
  const size = paletteSize(profile);
  if (size <= LOCAL_PALETTE_SMALL_LENGTH_LIMIT) {
    return reader.readBits(globalBits(profile)) + 1;
  }
  if (reader.readBits(1) === 0) return reader.readBits(6) + 1;
  if (reader.readBits(1) === 0) return reader.readBits(6) + 65;
  if (size <= LOCAL_PALETTE_MEDIUM_LENGTH_LIMIT) {
    throw new McoImageV3InvalidPayloadError('Invalid local palette length prefix');
  }
  const length = reader.readBits(bitLength(size - 129)) + 129;
  if (length > size) throw new McoImageV3InvalidPayloadError('Invalid local palette size');
  return length;
}

export function readLocalPaletteBitmapDescriptor(reader: BitReader, profile: PaletteProfileId) {
  const refs = [];
  for (let ref = 0; ref < paletteSize(profile); ref++) {
    if (reader.readBits(1) !== 0) refs.push(ref);
  }
  return refs;
}

export function readLocalPaletteSortedDeltaDescriptor(reader: BitReader, profile: PaletteProfileId) {
  const count = readLocalPaletteLength(reader, profile);
  if (count <= 0 || count > paletteSize(profile)) {
    throw new McoImageV3InvalidPayloadError('Invalid sorted local palette size');
  }
  const refs = [reader.readBits(globalBits(profile))];
  while (refs.length < count) refs.push(refs[refs.length - 1] + reader.readCompactUint() + 1);
  return refs;
}

export function readLocalPaletteRangeRunsDescriptor(reader: BitReader, profile: PaletteProfileId) {
  const runCount = reader.readRangeCompactUint(paletteSize(profile) - 1) + 1;
  if (runCount <= 0 || runCount > paletteSize(profile)) {
    throw new McoImageV3InvalidPayloadError('Invalid local palette range count');
  }
  const refs = [];
  let previousEnd = -1;
  for (let i = 0; i < runCount; i++) {
    const start = reader.readBits(globalBits(profile));
    const length = reader.readCompactUint() + 1;
    const end = start + length - 1;
    if (start <= previousEnd || end >= paletteSize(profile) ||
        refs.length + length > paletteSize(profile)) {
      throw new McoImageV3InvalidPayloadError('Invalid local palette range');
    }
    for (let offset = 0; offset < length; offset++) refs.push(start + offset);
    previousEnd = end;
  }
  return refs;
}

export function readLocalPaletteBankBitmapsDescriptor(reader: BitReader, profile: PaletteProfileId) {
  if (profile !== PaletteProfile.dynamicGlobal512) {
    throw new McoImageV3InvalidPayloadError('Bank bitmap descriptor requires dynamicGlobal512');
  }
  const bankMask = reader.readBits(8);
  if (bankMask === 0) throw new McoImageV3InvalidPayloadError('Empty bank bitmap palette');
  const refs = [];
  for (let bank = 0; bank < 8; bank++) {
    if ((bankMask & (1 << bank)) === 0) continue;
    const beforeBank = refs.length;
    for (let offset = 0; offset < 64; offset++) {
      if (reader.readBits(1) !== 0) refs.push((bank << 6) | offset);
    }
    if (refs.length === beforeBank) {
      throw new McoImageV3InvalidPayloadError('Bank bitmap palette contains an empty bank');
    }
  }
  return refs;
}

export function readLocalPaletteOrderedBanked8x64Descriptor(reader: BitReader, profile: PaletteProfileId) {
  if (profile !== PaletteProfile.dynamicGlobal512) {
    throw new McoImageV3InvalidPayloadError('Ordered banked descriptor requires dynamicGlobal512');
  }
  const count = readLocalPaletteLength(reader, profile);
  const multipleBanks = reader.readBits(1) !== 0;
  if (!multipleBanks) {
    if (count > 64) {
      throw new McoImageV3InvalidPayloadError('Single-bank palette contains too many colors');
    }
    const bank = reader.readBits(3);
    const refs = [];
    for (let i = 0; i < count; i++) refs.push((bank << 6) | reader.readBits(6));
    return refs;
  }
  const bankMask = reader.readBits(8);
  const bankTotal = bitCount(bankMask);
  if (bankTotal <= 1) {
    throw new McoImageV3InvalidPayloadError('Invalid ordered banked palette mask');
  }
  if (count > bankTotal * 64) {
    throw new McoImageV3InvalidPayloadError('Ordered banked palette contains too many colors');
  }
  const banks = [];
  for (let bank = 0; bank < 8; bank++) if ((bankMask & (1 << bank)) !== 0) banks.push(bank);
  const bankBits = bitLength(bankTotal - 1);
  const refs = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const bankIndex = reader.readBits(bankBits);
    if (bankIndex >= banks.length) {
      throw new McoImageV3InvalidPayloadError('Invalid ordered banked palette bank index');
    }
    used.add(bankIndex);
    refs.push((banks[bankIndex] << 6) | reader.readBits(6));
  }
  if (used.size !== bankTotal) {
    throw new McoImageV3InvalidPayloadError('Ordered banked palette contains an unused bank');
  }
  return refs;
}

export function readLocalPaletteBankDescriptor(reader: BitReader, profile: PaletteProfileId) {
  if (profile !== PaletteProfile.dynamicGlobal512) {
    throw new McoImageV3InvalidPayloadError('Bank palette descriptor requires dynamicGlobal512');
  }
  const subtype = reader.readBits(1);
  if (subtype === LOCAL_PALETTE_BANK_DESCRIPTOR_BITMAPS) {
    return readLocalPaletteBankBitmapsDescriptor(reader, profile);
  }
  if (subtype === LOCAL_PALETTE_BANK_DESCRIPTOR_ORDERED_8X64) {
    return readLocalPaletteOrderedBanked8x64Descriptor(reader, profile);
  }
  throw new McoImageV3InvalidPayloadError('Unknown bank palette descriptor');
}

export function readLocalPaletteDescriptorBody(reader: BitReader, profile: PaletteProfileId, descriptor: number) {
  let refs;
  switch (descriptor) {
    case LOCAL_PALETTE_DESCRIPTOR_BITMAP:
      refs = readLocalPaletteBitmapDescriptor(reader, profile);
      break;
    case LOCAL_PALETTE_DESCRIPTOR_SORTED_DELTA:
      refs = readLocalPaletteSortedDeltaDescriptor(reader, profile);
      break;
    case LOCAL_PALETTE_DESCRIPTOR_RANGE_RUNS:
      refs = readLocalPaletteRangeRunsDescriptor(reader, profile);
      break;
    case LOCAL_PALETTE_DESCRIPTOR_BANK_BITMAPS:
      refs = readLocalPaletteBankDescriptor(reader, profile);
      break;
    default:
      throw new McoImageV3InvalidPayloadError('Unknown local palette descriptor');
  }
  if (refs.length === 0 || refs.length > paletteSize(profile)) {
    throw new McoImageV3InvalidPayloadError('Invalid compact local palette size');
  }
  const colors = [];
  const seen = new Set();
  for (const ref of refs) {
    if (!Number.isInteger(ref) || ref < 0 || ref >= paletteSize(profile) || seen.has(ref)) {
      throw new McoImageV3InvalidPayloadError('Invalid compact local palette');
    }
    seen.add(ref);
    colors.push(globalIndexForProfileRef(profile, ref));
  }
  return colors;
}

export function readLocalPalette(reader: BitReader, profile: PaletteProfileId) {
  const prefix = readLocalPalettePrefix(reader, profile);
  if (prefix.descriptor !== undefined) {
    return readLocalPaletteDescriptorBody(reader, profile, prefix.descriptor);
  }
  const colors = [];
  const seen = new Set();
  for (let i = 0; i < prefix.length; i++) {
    const color = readColorRef(reader, profile);
    if (seen.has(color)) throw new McoImageV3InvalidPayloadError('Duplicate local color');
    seen.add(color);
    colors.push(color);
  }
  return colors;
}

