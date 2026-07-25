import { describe, it, expect } from 'vitest';
import { okToMqttState } from './okToMqttState';

describe('okToMqttState', () => {
  it('confirmed wins over everything', () => {
    expect(okToMqttState({ okToMqttViolation: 1, bitfield: null })).toBe('violation');
  });

  it('confirmed with a readable bit', () => {
    expect(okToMqttState({ okToMqttViolation: 1, bitfield: 0 })).toBe('violation');
  });

  it('null bitfield', () => {
    expect(okToMqttState({ okToMqttViolation: 0, bitfield: null })).toBe('unknown');
  });

  it('undefined bitfield (field absent)', () => {
    expect(okToMqttState({ okToMqttViolation: 0 })).toBe('unknown');
  });

  it('bit 0 set', () => {
    expect(okToMqttState({ okToMqttViolation: 0, bitfield: 1 })).toBe('ok');
  });

  it('bit 0 set alongside other bits', () => {
    expect(okToMqttState({ okToMqttViolation: 0, bitfield: 3 })).toBe('ok');
  });

  it('bit 0 clear, not flagged (opted out, no violation attributed)', () => {
    expect(okToMqttState({ okToMqttViolation: 0, bitfield: 0 })).toBe('optedOut');
  });

  it('bit 0 clear with other bits set', () => {
    expect(okToMqttState({ okToMqttViolation: 0, bitfield: 2 })).toBe('optedOut');
  });

  it('missing flag defaults to not-violating', () => {
    expect(okToMqttState({ bitfield: 1 })).toBe('ok');
  });

  it('BIGINT-as-string coercion (PG/MySQL)', () => {
    expect(okToMqttState({ okToMqttViolation: '1' as unknown as number })).toBe('violation');
  });
});
