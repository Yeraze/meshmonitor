import { describe, it, expect } from 'vitest';
import { nodeMatchesSearch, visibleNodeNumSet } from './nodeSearch';

const nodes = [
  { nodeNum: 0x1a2b3c4d, longName: 'Mountain Repeater', shortName: 'MTN', nodeId: '!1a2b3c4d' },
  { nodeNum: 0x09a1, longName: 'Punk Not Dead', shortName: 'PUNK', nodeId: '!000009a1' },
  { nodeNum: 42, longName: null, shortName: null, nodeId: null },
];

describe('nodeMatchesSearch', () => {
  it('matches everything when the term is empty or whitespace', () => {
    expect(nodeMatchesSearch(nodes[0], '')).toBe(true);
    expect(nodeMatchesSearch(nodes[0], '   ')).toBe(true);
  });

  it('matches case-insensitively on long name', () => {
    expect(nodeMatchesSearch(nodes[0], 'mountain')).toBe(true);
    expect(nodeMatchesSearch(nodes[0], 'PUNK')).toBe(false);
  });

  it('matches on short name and node id', () => {
    expect(nodeMatchesSearch(nodes[1], 'punk')).toBe(true);
    expect(nodeMatchesSearch(nodes[1], '000009a1')).toBe(true);
  });

  it('matches on hex and decimal node number even with no names', () => {
    expect(nodeMatchesSearch(nodes[2], '42')).toBe(true);
    expect(nodeMatchesSearch(nodes[2], '!2a')).toBe(true);
  });

  it('returns false on no match', () => {
    expect(nodeMatchesSearch(nodes[0], 'zzz')).toBe(false);
  });
});

describe('visibleNodeNumSet', () => {
  it('returns null for an empty term', () => {
    expect(visibleNodeNumSet(nodes, '')).toBeNull();
  });

  it('returns only matching node numbers', () => {
    const set = visibleNodeNumSet(nodes, 'punk');
    expect(set).not.toBeNull();
    expect(set!.has(0x09a1)).toBe(true);
    expect(set!.has(0x1a2b3c4d)).toBe(false);
    expect(set!.size).toBe(1);
  });
});
