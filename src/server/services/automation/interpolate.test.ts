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
});

describe('extractPaths', () => {
  it('lists distinct referenced paths', () => {
    expect(extractPaths('{{ trigger.from }} {{ var.x }} {{trigger.from}}').sort())
      .toEqual(['trigger.from', 'var.x']);
    expect(extractPaths('none')).toEqual([]);
  });
});
