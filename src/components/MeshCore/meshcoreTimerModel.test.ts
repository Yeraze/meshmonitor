/**
 * MeshCore Timer Trigger model — multi-channel back-compat reader (#6230).
 *
 * New timers store `channelIndexes` (an array). Old timers stored a single
 * `channelIndex`; the reader coerces that scalar into a one-item array so saved
 * single-channel timers keep working without a destructive migration.
 */
import { describe, it, expect } from 'vitest';
import { meshCoreTimerChannelIndexes, newMeshCoreTimerTrigger } from './meshcoreTimerModel';

describe('meshCoreTimerChannelIndexes (#6230)', () => {
  it('reads the new channelIndexes array', () => {
    expect(meshCoreTimerChannelIndexes({ channelIndexes: [0, 2] })).toEqual([0, 2]);
  });

  it('migrates an old single channelIndex into a one-item array', () => {
    expect(meshCoreTimerChannelIndexes({ channelIndex: 3 })).toEqual([3]);
  });

  it('migrates channel 0 (falsy but valid)', () => {
    expect(meshCoreTimerChannelIndexes({ channelIndex: 0 })).toEqual([0]);
  });

  it('prefers channelIndexes over the legacy channelIndex', () => {
    expect(meshCoreTimerChannelIndexes({ channelIndexes: [1], channelIndex: 5 })).toEqual([1]);
  });

  it('falls back to the legacy channelIndex when the array is empty', () => {
    expect(meshCoreTimerChannelIndexes({ channelIndexes: [], channelIndex: 4 })).toEqual([4]);
  });

  it('returns an empty array when nothing is set', () => {
    expect(meshCoreTimerChannelIndexes({})).toEqual([]);
  });

  it('seeds a new trigger with a one-item channelIndexes array', () => {
    expect(newMeshCoreTimerTrigger().channelIndexes).toEqual([0]);
  });
});
