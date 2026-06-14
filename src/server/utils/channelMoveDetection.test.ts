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

  it('returns empty when two channels share the same PSK+name (issue #3452 - phantom swap)', () => {
    // Both slots have identical (psk, name) — ambiguous, must not produce a move
    const before: ChannelSnapshot[] = [
      { id: 1, psk: 'defaultPsk', name: 'LongFast' },
      { id: 3, psk: 'defaultPsk', name: 'LongFast' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 1, psk: 'defaultPsk', name: 'LongFast' },
      { id: 3, psk: 'defaultPsk', name: 'LongFast' },
    ];
    expect(detectChannelMoves(before, after)).toEqual([]);
  });

  it('does not produce phantom bidirectional swap when duplicate (psk,name) present in both snapshots', () => {
    // Simulates the exact scenario from issue #3452:
    // channels 1 and 3 share (psk, name) — detector must decline, not swap them
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'sharedPsk', name: 'SharedName' },
      { id: 2, psk: 'pskB', name: 'Beta' },
      { id: 3, psk: 'sharedPsk', name: 'SharedName' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 0, psk: 'pskA', name: 'Alpha' },
      { id: 1, psk: 'sharedPsk', name: 'SharedName' },
      { id: 2, psk: 'pskB', name: 'Beta' },
      { id: 3, psk: 'sharedPsk', name: 'SharedName' },
    ];
    expect(detectChannelMoves(before, after)).toEqual([]);
  });

  it('detects a real move when the duplicate channel is removed (becomes unique)', () => {
    // One of the duplicate slots is replaced — remaining unique identity can be tracked
    const before: ChannelSnapshot[] = [
      { id: 1, psk: 'pskA', name: 'Alpha' },
      { id: 2, psk: 'pskB', name: 'Beta' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 1, psk: 'pskB', name: 'Beta' },
      { id: 2, psk: 'pskA', name: 'Alpha' },
    ];
    const moves = detectChannelMoves(before, after);
    expect(moves).toHaveLength(2);
    expect(moves).toContainEqual({ from: 1, to: 2 });
    expect(moves).toContainEqual({ from: 2, to: 1 });
  });

  it('skips duplicate-identity channels but still detects moves for unique ones', () => {
    // Channels 1+3 share (psk, name) → skipped; channel 0 (unique) moves to slot 4
    const before: ChannelSnapshot[] = [
      { id: 0, psk: 'uniquePsk', name: 'Unique' },
      { id: 1, psk: 'sharedPsk', name: 'Shared' },
      { id: 3, psk: 'sharedPsk', name: 'Shared' },
    ];
    const after: ChannelSnapshot[] = [
      { id: 1, psk: 'sharedPsk', name: 'Shared' },
      { id: 3, psk: 'sharedPsk', name: 'Shared' },
      { id: 4, psk: 'uniquePsk', name: 'Unique' },
    ];
    const moves = detectChannelMoves(before, after);
    expect(moves).toEqual([{ from: 0, to: 4 }]);
  });
});
