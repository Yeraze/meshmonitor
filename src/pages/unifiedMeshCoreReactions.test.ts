import { describe, it, expect } from 'vitest';
import { groupUnifiedMeshCoreReactions, type UnifiedReactionFields } from './unifiedMeshCoreReactions';

const plain = (key: string, refs: string[]): UnifiedReactionFields => ({
  dedupKey: key,
  fromNodeId: 'pk-' + key,
  meshcoreRowRefs: refs,
});
const react = (key: string, name: string, refs: string[], emoji = '👍'): UnifiedReactionFields => ({
  dedupKey: key,
  fromNodeId: 'pk-' + name,
  fromNodeLongName: name,
  reactionEmoji: emoji,
  reactionTargetRefs: refs,
});

describe('groupUnifiedMeshCoreReactions', () => {
  it('returns the same array when nothing is a reaction', () => {
    const msgs = [plain('a', ['r1'])];
    const out = groupUnifiedMeshCoreReactions(msgs);
    expect(out.rows).toBe(msgs);
    expect(out.chipsByTarget.size).toBe(0);
  });

  it('puts a chip on the target, counting two reactors', () => {
    const out = groupUnifiedMeshCoreReactions([
      plain('t', ['r1']),
      react('x1', 'Ann', ['r1']),
      react('x2', 'Bob', ['r1']),
    ]);
    expect(out.rows.map(r => r.dedupKey)).toEqual(['t']);
    const chips = out.chipsByTarget.get('t')!;
    expect(chips).toHaveLength(1);
    expect(chips[0].count).toBe(2);
    expect(chips[0].reactors).toEqual(['Ann', 'Bob']);
  });

  it('counts one reactor once across two entries', () => {
    const out = groupUnifiedMeshCoreReactions([
      plain('t', ['r1']),
      react('x1', 'Ann', ['r1']),
      react('x2', 'Ann', ['r1']),
    ]);
    expect(out.chipsByTarget.get('t')![0].count).toBe(1);
  });

  it('hides a reaction whose target is not loaded, then shows it once loaded', () => {
    const r = react('x1', 'Ann', ['r9']);
    const before = groupUnifiedMeshCoreReactions([plain('t', ['r1']), r]);
    expect(before.rows.map(m => m.dedupKey)).toEqual(['t']);
    expect(before.chipsByTarget.size).toBe(0);
    const after = groupUnifiedMeshCoreReactions([plain('t', ['r1']), plain('old', ['r9']), r]);
    expect(after.chipsByTarget.get('old')).toHaveLength(1);
  });

  it('keeps a reaction with no refs as a row', () => {
    const out = groupUnifiedMeshCoreReactions([plain('t', ['r1']), react('x1', 'Ann', [])]);
    expect(out.rows.map(m => m.dedupKey)).toEqual(['t', 'x1']);
  });

  it('resolves a ref through a later entry', () => {
    const out = groupUnifiedMeshCoreReactions([react('x1', 'Ann', ['r1']), plain('t', ['r1'])]);
    expect(out.rows.map(m => m.dedupKey)).toEqual(['t']);
    expect(out.chipsByTarget.get('t')).toHaveLength(1);
  });

  it('uses the first loaded ref', () => {
    const out = groupUnifiedMeshCoreReactions([
      plain('b', ['rb']),
      react('x1', 'Ann', ['ra', 'rb']),
    ]);
    expect(out.chipsByTarget.get('b')).toHaveLength(1);
  });
});
