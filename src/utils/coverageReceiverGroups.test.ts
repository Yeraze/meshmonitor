/**
 * coverageReceiverGroups (#5277 Phase 2 WP4) — pure grouping/search/sort
 * helpers behind CoverageReceiverFilter. See COVERAGE_P2_SPEC.md §2.9/§3.
 */
import { describe, it, expect } from 'vitest';
import {
  groupReceiversBySource,
  matchesReceiverSearch,
  filterReceiverGroups,
  groupSelectionState,
  receiverSelectionSummary,
} from './coverageReceiverGroups';
import { receiverKey } from './coverageReceiverFilter';
import type { CoverageReceiverDto } from '../types/coverage';

function receiver(overrides: Partial<CoverageReceiverDto>): CoverageReceiverDto {
  return {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    longName: 'Receiver One',
    shortName: 'R1',
    latitude: 26.1,
    longitude: -80.2,
    lastReceivedAt: 1,
    receptionCount: 10,
    ...overrides,
  };
}

describe('groupReceiversBySource', () => {
  it('groups by sourceId, preserving first-seen source order', () => {
    const receivers = [
      receiver({ sourceId: 'src-b', sourceName: 'Source B', receiverId: '!b1' }),
      receiver({ sourceId: 'src-a', sourceName: 'Source A', receiverId: '!a1' }),
      receiver({ sourceId: 'src-b', sourceName: 'Source B', receiverId: '!b2' }),
    ];
    const groups = groupReceiversBySource(receivers);
    expect(groups.map((g) => g.sourceId)).toEqual(['src-b', 'src-a']);
    expect(groups[0].receivers).toHaveLength(2);
    expect(groups[1].receivers).toHaveLength(1);
  });

  it('sorts each group by receptionCount descending', () => {
    const receivers = [
      receiver({ receiverId: '!low', receptionCount: 2 }),
      receiver({ receiverId: '!high', receptionCount: 99 }),
      receiver({ receiverId: '!mid', receptionCount: 40 }),
    ];
    const groups = groupReceiversBySource(receivers);
    expect(groups[0].receivers.map((r) => r.receiverId)).toEqual(['!high', '!mid', '!low']);
  });
});

describe('matchesReceiverSearch', () => {
  const r = receiver({ longName: 'Long Name', shortName: 'SHRT', receiverId: '!deadbeef', sourceName: 'My Source' });

  it('matches long name, short name, id, and source name case-insensitively', () => {
    expect(matchesReceiverSearch(r, 'long')).toBe(true);
    expect(matchesReceiverSearch(r, 'shrt')).toBe(true);
    expect(matchesReceiverSearch(r, 'DEADBEEF')).toBe(true);
    expect(matchesReceiverSearch(r, 'my source')).toBe(true);
  });

  it('an empty query matches everything', () => {
    expect(matchesReceiverSearch(r, '')).toBe(true);
    expect(matchesReceiverSearch(r, '   ')).toBe(true);
  });

  it('no match returns false', () => {
    expect(matchesReceiverSearch(r, 'nope')).toBe(false);
  });

  it('handles null names gracefully', () => {
    const bare = receiver({ longName: null, shortName: null, receiverId: '!ffffffff' });
    expect(matchesReceiverSearch(bare, 'ffffffff')).toBe(true);
    expect(matchesReceiverSearch(bare, 'nothing')).toBe(false);
  });
});

describe('filterReceiverGroups', () => {
  it('narrows rows within groups and drops groups left empty', () => {
    const groups = groupReceiversBySource([
      receiver({ sourceId: 'src-a', sourceName: 'Alpha', receiverId: '!a1', longName: 'Match Me' }),
      receiver({ sourceId: 'src-a', sourceName: 'Alpha', receiverId: '!a2', longName: 'No Hit' }),
      receiver({ sourceId: 'src-b', sourceName: 'Beta', receiverId: '!b1', longName: 'Nothing Here' }),
    ]);

    const filtered = filterReceiverGroups(groups, 'match');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sourceId).toBe('src-a');
    expect(filtered[0].receivers).toHaveLength(1);
  });

  it('an empty query returns the groups unchanged', () => {
    const groups = groupReceiversBySource([receiver({})]);
    expect(filterReceiverGroups(groups, '')).toEqual(groups);
  });
});

describe('groupSelectionState', () => {
  const groups = groupReceiversBySource([
    receiver({ sourceId: 'src-a', receiverId: '!a1' }),
    receiver({ sourceId: 'src-a', receiverId: '!a2' }),
  ]);
  const group = groups[0];

  it('is "all" when nothing in the group is deselected', () => {
    expect(groupSelectionState(group, new Set())).toBe('all');
  });

  it('is "none" when every receiver in the group is deselected', () => {
    const deselected = new Set([receiverKey('src-a', '!a1'), receiverKey('src-a', '!a2')]);
    expect(groupSelectionState(group, deselected)).toBe('none');
  });

  it('is "partial" when some but not all are deselected', () => {
    const deselected = new Set([receiverKey('src-a', '!a1')]);
    expect(groupSelectionState(group, deselected)).toBe('partial');
  });

  it('a same receiverId on a different source does not affect this group (carry-over a)', () => {
    const deselected = new Set([receiverKey('src-other', '!a1')]);
    expect(groupSelectionState(group, deselected)).toBe('all');
  });
});

describe('receiverSelectionSummary', () => {
  it('counts selected vs total across all receivers', () => {
    const receivers = [
      receiver({ sourceId: 'src-a', receiverId: '!a1' }),
      receiver({ sourceId: 'src-a', receiverId: '!a2' }),
      receiver({ sourceId: 'src-b', receiverId: '!a1' }),
    ];
    const deselected = new Set([receiverKey('src-a', '!a1')]);
    expect(receiverSelectionSummary(receivers, deselected)).toEqual({ selected: 2, total: 3 });
  });
});
