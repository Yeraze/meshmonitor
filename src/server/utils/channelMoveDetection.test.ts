import { describe, it, expect } from 'vitest';
import { detectChannelMoves, ChannelSnapshot } from './channelMoveDetection.js';

describe('detectChannelMoves', () => {
  it('returns empty array when no channels moved', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'pskB', name: 'Beta' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'pskB', name: 'Beta' },
    ];
    expect(detectChannelMoves(before, after)).toEqual([]);
  });

  it('detects a simple move (channel moved to different slot)', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'pskB', name: 'Beta' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'pskC', name: 'Gamma' },
      { id: 2, psk: 'pskB', name: 'Beta' },
    ];
    expect(detectChannelMoves(before, after)).toEqual([
      { from: 1, to: 2 },
    ]);
  });

  it('detects both directions of a channel swap', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'MediumFast' },
      { id: 1, psk: 'pskB', name: 'Romandie' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: 'pskB', name: 'Romandie' },
      { id: 1, psk: 'pskA', name: 'MediumFast' },
    ];
    const moves = detectChannelMoves(before, after);
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({ from: 0, to: 1 });
    expect(moves).toContainEqual({ from: 1, to: 0 });
  });

  it('skips channels with empty or null PSK', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: '', name: 'Empty' },
      { id: 1, psk: null, name: 'Null' },
      { id: 2, psk: 'pskA', name: 'Real' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: '', name: 'Empty' },
      { id: 1, psk: null, name: 'Null' },
      { id: 2, psk: 'pskA', name: 'Real' },
    ];
    expect(detectChannelMoves(before, after)).toEqual([]);
  });

  it('does not produce duplicate moves', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 1, psk: 'pskA', name: 'Alpha' },
    ];
    const moves = detectChannelMoves(before, after);
    expect(moves).toEqual([{ from: 0, to: 1 }]);
  });

  it('detects swap in a 3-channel config', () => {
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'pskB', name: 'Beta' },
      { id: 2, psk: 'pskC', name: 'Gamma' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: 'pskB', name: 'Beta' },
      { id: 1, psk: 'pskA', name: 'Alpha' },
      { id: 2, psk: 'pskC', name: 'Gamma' },
    ];
    const moves = detectChannelMoves(before, after);
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({ from: 0, to: 1 });
    expect(moves).toContainEqual({ from: 1, to: 0 });
  });
});
