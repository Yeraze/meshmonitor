/**
 * @vitest-environment jsdom
 *
 * remapChannelLastRead (#5379): last-read markers follow their channel after an
 * on-device reorder, in localStorage and in the hydrated server snapshot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  channelLastReadKey,
  configureReadStateTransport,
  hydrateReadState,
  loadChannelLastRead,
  remapChannelLastRead,
} from './meshcoreUnreadStore';
import { remapChannelKey, slotMoveMap } from './meshcoreChannelReorderEvents';

beforeEach(() => {
  localStorage.clear();
  configureReadStateTransport(null);
});

describe('remapChannelLastRead', () => {
  it('swaps local markers and leaves other sources alone', () => {
    localStorage.setItem(channelLastReadKey('a'), JSON.stringify({ 0: 5, 1: 10, 2: 20 }));
    localStorage.setItem(channelLastReadKey('b'), JSON.stringify({ 1: 99 }));
    remapChannelLastRead('a', [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
    expect(loadChannelLastRead('a')).toEqual({ 0: 5, 1: 20, 2: 10 });
    expect(loadChannelLastRead('b')).toEqual({ 1: 99 });
  });

  it('remaps the hydrated server snapshot too, so a stale server key cannot win the max-merge', async () => {
    configureReadStateTransport({
      load: async () => ({ meshcore_channel: { 1: 500 }, meshcore_dm: {} }),
      save: async () => {},
    });
    await hydrateReadState('a');
    localStorage.setItem(channelLastReadKey('a'), JSON.stringify({ 1: 100 }));
    remapChannelLastRead('a', [{ from: 1, to: 3 }, { from: 3, to: 1 }]);
    expect(loadChannelLastRead('a')).toEqual({ 3: 500 });
  });
});

describe('remapChannelKey', () => {
  const map = slotMoveMap([{ from: 1, to: 2 }, { from: 2, to: 1 }]);
  it('rewrites channel keys and passes everything else through', () => {
    expect(remapChannelKey('channel-1', map)).toBe('channel-2');
    expect(remapChannelKey('channel-5', map)).toBe('channel-5');
    expect(remapChannelKey('abcdef', map)).toBe('abcdef');
    expect(remapChannelKey(undefined, map)).toBeUndefined();
  });
});
