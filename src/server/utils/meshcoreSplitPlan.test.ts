import { describe, it, expect } from 'vitest';
import { planMeshCoreTextParts } from './meshcoreSplitPlan.js';
import { utf8ByteLength } from './splitUtf8Message.js';

describe('planMeshCoreTextParts', () => {
  it('uses the DM cap (160) for a DM', () => {
    expect(planMeshCoreTextParts('hi', { isDm: true, split: false }).maxBytes).toBe(160);
  });
  it('derives the channel cap from the node name', () => {
    expect(planMeshCoreTextParts('hi', { isDm: false, nodeName: 'abcdefghijkl', split: false }).maxBytes).toBe(146);
  });
  it('falls back to the worst-case channel cap when the name is unknown', () => {
    expect(planMeshCoreTextParts('hi', { isDm: false, split: false }).maxBytes).toBe(127);
  });
  it('truncates to one part when split is off', () => {
    const r = planMeshCoreTextParts('word '.repeat(100), { isDm: true, split: false });
    expect(r.parts).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(utf8ByteLength(r.parts[0])).toBeLessThanOrEqual(160);
  });
  it('splits into at most 3 marked parts that fit the cap', () => {
    const r = planMeshCoreTextParts('word '.repeat(60), { isDm: false, nodeName: 'abcdefghijkl', split: true });
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.parts.length).toBeLessThanOrEqual(3);
    expect(r.parts[0].startsWith('(1/')).toBe(true);
    for (const p of r.parts) expect(utf8ByteLength(p)).toBeLessThanOrEqual(146);
  });
  it('counts multi-byte text in bytes', () => {
    const r = planMeshCoreTextParts('é'.repeat(300), { isDm: true, split: true });
    expect(r.parts.length).toBeLessThanOrEqual(3);
    for (const p of r.parts) expect(utf8ByteLength(p)).toBeLessThanOrEqual(160);
    expect(r.truncated).toBe(true);
  });
  it('does not split a message that fits', () => {
    const r = planMeshCoreTextParts('short', { isDm: true, split: true });
    expect(r.parts).toEqual(['short']);
    expect(r.truncated).toBe(false);
  });
});
