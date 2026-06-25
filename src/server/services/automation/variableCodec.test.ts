import { describe, it, expect } from 'vitest';
import { parseVarConfig, encodeValue, decodeValue, flagExpiry } from './variableCodec.js';

describe('parseVarConfig', () => {
  it('parses valid JSON and tolerates bad/empty input', () => {
    expect(parseVarConfig('{"flagDurationSeconds":60}')).toEqual({ flagDurationSeconds: 60 });
    expect(parseVarConfig('')).toEqual({});
    expect(parseVarConfig(null)).toEqual({});
    expect(parseVarConfig('not json')).toEqual({});
    expect(parseVarConfig('123')).toEqual({}); // not an object
  });
});

describe('encodeValue', () => {
  it('encodes strings', () => {
    expect(encodeValue('string', 'hi')).toBe('hi');
    expect(encodeValue('string', 42)).toBe('42');
    expect(encodeValue('string', null)).toBeNull();
  });

  it('encodes integers (truncating) and rejects non-numeric', () => {
    expect(encodeValue('integer', 3.9)).toBe('3');
    expect(encodeValue('integer', '7')).toBe('7');
    expect(encodeValue('integer', 'abc')).toBeNull();
  });

  it('encodes floats and rejects non-numeric', () => {
    expect(encodeValue('float', 3.5)).toBe('3.5');
    expect(encodeValue('float', '2.25')).toBe('2.25');
    expect(encodeValue('float', 'nope')).toBeNull();
  });

  it('encodes booleans and flags from varied truthy inputs', () => {
    expect(encodeValue('boolean', true)).toBe('true');
    expect(encodeValue('boolean', 'false')).toBe('false');
    expect(encodeValue('boolean', 0)).toBe('false');
    expect(encodeValue('flag', 1)).toBe('true');
    expect(encodeValue('flag', 'yes')).toBe('true');
  });
});

describe('decodeValue', () => {
  it('round-trips each type', () => {
    expect(decodeValue('string', 'hi')).toBe('hi');
    expect(decodeValue('integer', '7')).toBe(7);
    expect(decodeValue('float', '2.25')).toBe(2.25);
    expect(decodeValue('boolean', 'true')).toBe(true);
    expect(decodeValue('flag', 'false')).toBe(false);
  });

  it('returns null for absent values and unparseable numbers', () => {
    expect(decodeValue('string', null)).toBeNull();
    expect(decodeValue('integer', 'xx')).toBeNull();
    expect(decodeValue('float', 'xx')).toBeNull();
  });
});

describe('flagExpiry', () => {
  it('computes now + duration for a positive duration', () => {
    expect(flagExpiry({ flagDurationSeconds: 60 }, 1_000_000)).toBe(1_060_000);
  });

  it('returns null when there is no positive duration', () => {
    expect(flagExpiry({}, 1_000_000)).toBeNull();
    expect(flagExpiry({ flagDurationSeconds: 0 }, 1_000_000)).toBeNull();
    expect(flagExpiry({ flagDurationSeconds: -5 }, 1_000_000)).toBeNull();
  });
});

describe('json variable type', () => {
  it('round-trips objects and arrays', () => {
    const obj = { a: 1, b: { c: 'x' }, d: [1, 2] };
    expect(decodeValue('json', encodeValue('json', obj))).toEqual(obj);
    expect(decodeValue('json', encodeValue('json', [1, 2, 3]))).toEqual([1, 2, 3]);
  });
  it('stores a JSON string as-is (round-trips)', () => {
    expect(encodeValue('json', '{"a":1}')).toBe('{"a":1}');
    expect(decodeValue('json', '{"a":1}')).toEqual({ a: 1 });
  });
  it('decodes malformed JSON as null', () => {
    expect(decodeValue('json', 'not json')).toBeNull();
    expect(decodeValue('json', null)).toBeNull();
  });
});
