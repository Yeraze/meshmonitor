import { describe, it, expect } from 'vitest';
import type { DeviceInfo } from '../types/device.js';
import { mentionCandidatesFromNodes } from './mentionCandidates.js';

function node(partial: Partial<DeviceInfo> & { nodeNum: number }): DeviceInfo {
  return partial as DeviceInfo;
}

describe('mentionCandidatesFromNodes (#5276)', () => {
  it('orders by last heard, newest first', () => {
    const candidates = mentionCandidatesFromNodes([
      node({ nodeNum: 1, user: { id: '!00000001', longName: 'Old', shortName: 'OLD' }, lastHeard: 100 }),
      node({ nodeNum: 2, user: { id: '!00000002', longName: 'Recent', shortName: 'NEW' }, lastHeard: 900 }),
    ]);
    expect(candidates.map(c => c.longName)).toEqual(['Recent', 'Old']);
  });

  it('leaves the local node out of its own list', () => {
    const candidates = mentionCandidatesFromNodes(
      [
        node({ nodeNum: 1, user: { id: '!00000001', longName: 'Me', shortName: 'ME' } }),
        node({ nodeNum: 2, user: { id: '!00000002', longName: 'Them', shortName: 'THM' } }),
      ],
      '!00000001'
    );
    expect(candidates.map(c => c.id)).toEqual(['!00000002']);
  });

  it('derives the id from the node number when the user record has none', () => {
    const candidates = mentionCandidatesFromNodes([node({ nodeNum: 0xffccee11 })]);
    // Must be exactly 8 hex digits, or the mention token regex will not match it.
    expect(candidates[0].id).toBe('!ffccee11');
    expect(candidates[0].longName).toBe('');
    expect(candidates[0].shortName).toBe('');
  });

  it('lowercases ids and trims names', () => {
    const candidates = mentionCandidatesFromNodes([
      node({ nodeNum: 1, user: { id: '!00A1B2C3', longName: '  Field East  ', shortName: ' FE ' } }),
    ]);
    expect(candidates[0]).toEqual({ id: '!00a1b2c3', longName: 'Field East', shortName: 'FE' });
  });

  it('returns nothing for an empty or missing node list', () => {
    expect(mentionCandidatesFromNodes(undefined)).toEqual([]);
    expect(mentionCandidatesFromNodes([])).toEqual([]);
  });
});
