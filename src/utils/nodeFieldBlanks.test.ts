import { describe, it, expect } from 'vitest';
import {
  isBlankMacAddr,
  isPlaceholderLongName,
  isPlaceholderShortName,
} from './nodeFieldBlanks.js';

describe('isBlankMacAddr (#5231)', () => {
  it('treats absent values as blank', () => {
    expect(isBlankMacAddr(null)).toBe(true);
    expect(isBlankMacAddr(undefined)).toBe(true);
    expect(isBlankMacAddr('')).toBe(true);
  });

  it('treats the deprecated all-zero MAC as blank', () => {
    expect(isBlankMacAddr('000000000000')).toBe(true);
    expect(isBlankMacAddr('00000000000000000000')).toBe(true);
  });

  it('treats a real MAC as data', () => {
    expect(isBlankMacAddr('c4d266f1c31d')).toBe(false);
    // Leading zeros are fine as long as something is set.
    expect(isBlankMacAddr('00000000000d')).toBe(false);
  });

  it('handles the raw byte form seen at the protobuf boundary', () => {
    // protobuf.js hands back an EMPTY buffer for an unset `bytes` field.
    expect(isBlankMacAddr(new Uint8Array(0))).toBe(true);
    expect(isBlankMacAddr(new Uint8Array([0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isBlankMacAddr(new Uint8Array([0xc4, 0xd2, 0x66, 0xf1, 0xc3, 0x1d]))).toBe(false);
  });
});

describe('isPlaceholderLongName (#5231)', () => {
  it('matches MeshMonitor stub rows', () => {
    expect(isPlaceholderLongName('Node !9e80e848')).toBe(true);
    expect(isPlaceholderLongName('Node !9E80E848')).toBe(true);
  });

  it('leaves real names alone', () => {
    expect(isPlaceholderLongName('Seeed Solar Node')).toBe(false);
    expect(isPlaceholderLongName('Node 12')).toBe(false);
    expect(isPlaceholderLongName('')).toBe(false);
    expect(isPlaceholderLongName(null)).toBe(false);
  });
});

describe('isPlaceholderShortName (#5231)', () => {
  it('matches the derived last-4-hex stub for its own node id', () => {
    expect(isPlaceholderShortName('e848', '!9e80e848')).toBe(true);
    expect(isPlaceholderShortName('E848', '!9e80e848')).toBe(true);
  });

  it('does not match a different node id', () => {
    expect(isPlaceholderShortName('e848', '!433b3de0')).toBe(false);
  });

  it('leaves real short names alone', () => {
    expect(isPlaceholderShortName('SKYC', '!9e80e848')).toBe(false);
  });

  it('is inert without a hex node id (MeshCore contacts)', () => {
    expect(isPlaceholderShortName('e848', undefined)).toBe(false);
    expect(isPlaceholderShortName('e848', 'mc:src:aabbccdd')).toBe(false);
  });
});
