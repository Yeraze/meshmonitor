import { describe, it, expect } from 'vitest';
import { planAutomatedTextParts } from './automatedTextSplit.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('planAutomatedTextParts (#6330)', () => {
  it('passes a text that fits through unchanged', () => {
    expect(planAutomatedTextParts('hi', { maxBytes: 200, split: true, ellipsis: true })).toEqual({ parts: ['hi'], truncated: false, maxBytes: 200 });
  });

  it('truncates to one part with split off, adding "..." only when asked', () => {
    const text = 'word '.repeat(100);
    const plain = planAutomatedTextParts(text, { maxBytes: 200, split: false });
    expect(plain.parts).toHaveLength(1);
    expect(plain.parts[0].endsWith('...')).toBe(false);
    const dots = planAutomatedTextParts(text, { maxBytes: 200, split: false, ellipsis: true });
    expect(dots.truncated).toBe(true);
    expect(dots.parts[0].endsWith('...')).toBe(true);
    expect(bytes(dots.parts[0])).toBeLessThanOrEqual(200);
  });

  it('caps a split at 3 marked parts and ends the cut one in "..."', () => {
    const plan = planAutomatedTextParts('word '.repeat(300), { maxBytes: 200, split: true, ellipsis: true });
    expect(plan.parts).toHaveLength(3);
    expect(plan.truncated).toBe(true);
    expect(plan.parts[2].startsWith('(3/3) ')).toBe(true);
    expect(plan.parts[2].endsWith('...')).toBe(true);
    for (const p of plan.parts) expect(bytes(p)).toBeLessThanOrEqual(200);
  });

  it('never halves a multi-byte character when adding "..."', () => {
    const plan = planAutomatedTextParts('\u{1F600}'.repeat(100), { maxBytes: 200, split: false, ellipsis: true });
    expect(bytes(plan.parts[0])).toBeLessThanOrEqual(200);
    expect(Array.from(plan.parts[0].slice(0, -3)).every((c) => c === '\u{1F600}')).toBe(true);
  });
});
