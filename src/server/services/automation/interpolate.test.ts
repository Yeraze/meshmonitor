import { describe, it, expect } from 'vitest';
import { interpolate, extractPaths } from './interpolate.js';

describe('interpolate', () => {
  const lookup = (p: string) => ({
    'trigger.from': 123,
    'trigger.text': 'ping',
    'var.greeting': 'hello',
    'var.enabled': true,
  } as Record<string, string | number | boolean>)[p];

  it('replaces known tokens and coerces values', () => {
    expect(interpolate('from {{ trigger.from }}: {{ trigger.text }}', lookup)).toBe('from 123: ping');
    expect(interpolate('{{var.greeting}} {{ var.enabled }}', lookup)).toBe('hello true');
  });

  it('renders unknown/empty tokens as empty string', () => {
    expect(interpolate('x{{ var.missing }}y', lookup)).toBe('xy');
    expect(interpolate('a{{  }}b', lookup)).toBe('ab');
  });

  it('returns non-templated strings unchanged', () => {
    expect(interpolate('no tokens here', lookup)).toBe('no tokens here');
  });

  it('never throws when lookup throws', () => {
    const bad = () => { throw new Error('boom'); };
    expect(interpolate('v={{ x }}', bad)).toBe('v=');
  });

  it('tolerates whitespace and multiple tokens', () => {
    expect(interpolate('{{trigger.from}}-{{trigger.from}}', lookup)).toBe('123-123');
  });

  it('formats NOW and *.timestamp epoch-ms tokens as a readable date/time', () => {
    const ms = new Date(2026, 5, 24, 19, 43, 11).getTime(); // local time
    const tsLookup = (p: string) => ({ 'NOW': ms, 'trigger.timestamp': ms } as Record<string, number>)[p];
    expect(interpolate('{{ trigger.timestamp }}', tsLookup)).toBe('2026-06-24 19:43:11');
    expect(interpolate('at {{ NOW }}', tsLookup)).toBe('at 2026-06-24 19:43:11');
    // raw epoch ms is NOT shown
    expect(interpolate('{{ trigger.timestamp }}', tsLookup)).not.toContain(String(ms));
  });

  it('leaves non-timestamp numeric tokens (incl. rxTime seconds) untouched', () => {
    const lk = (p: string) => ({ 'trigger.from': 123, 'trigger.rxTime': 1782331391 } as Record<string, number>)[p];
    expect(interpolate('{{ trigger.from }} {{ trigger.rxTime }}', lk)).toBe('123 1782331391');
  });

  it('does NOT format a var.* token even if it ends in "timestamp" (unknown units)', () => {
    const lk = (p: string) => ({ 'var.lastTimestamp': 1782331391 } as Record<string, number>)[p];
    expect(interpolate('{{ var.lastTimestamp }}', lk)).toBe('1782331391');
  });
});

describe('extractPaths', () => {
  it('lists distinct referenced paths', () => {
    expect(extractPaths('{{ trigger.from }} {{ var.x }} {{trigger.from}}').sort())
      .toEqual(['trigger.from', 'var.x']);
    expect(extractPaths('none')).toEqual([]);
  });
});
