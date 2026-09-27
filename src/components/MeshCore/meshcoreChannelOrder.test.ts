/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCustomOrder,
  sortChannels,
  moveItem,
  loadChannelSortMode,
  saveChannelSortMode,
  loadChannelCustomOrder,
  saveChannelCustomOrder,
  channelCustomOrderKey,
  channelSortModeKey,
  remapChannelCustomOrder,
} from './meshcoreChannelOrder';

const ch = (id: number, name: string) => ({ id, name });
const ids = (list: { id: number }[]) => list.map(c => c.id);

const channels = [ch(2, 'zulu'), ch(0, 'Public'), ch(3, ''), ch(1, '#alpha')];

describe('sortChannels', () => {
  it('device order sorts by slot index', () => {
    expect(ids(sortChannels(channels, 'device'))).toEqual([0, 1, 2, 3]);
  });

  it('name order ignores a leading # and case', () => {
    expect(ids(sortChannels(channels, 'name', { label: c => c.name || `Channel ${c.id}` })))
      .toEqual([1, 3, 0, 2]); // alpha, Channel 3, Public, zulu
  });

  it('last message puts newest first and silent channels last, in slot order', () => {
    const latest = { 2: 500, 0: 900 };
    expect(ids(sortChannels(channels, 'lastMessage', { latest }))).toEqual([0, 2, 1, 3]);
  });

  it('custom order follows the saved order', () => {
    expect(ids(sortChannels(channels, 'custom', { customOrder: [3, 1, 0, 2] }))).toEqual([3, 1, 0, 2]);
  });

  it('does not mutate the input', () => {
    const copy = [...channels];
    sortChannels(channels, 'device');
    expect(channels).toEqual(copy);
  });
});

describe('applyCustomOrder', () => {
  it('appends channels missing from the order in slot order and drops stale ids', () => {
    expect(ids(applyCustomOrder(channels, [9, 2, 0]))).toEqual([2, 0, 1, 3]);
  });

  it('falls back to slot order with an empty order', () => {
    expect(ids(applyCustomOrder(channels, []))).toEqual([0, 1, 2, 3]);
  });
});

describe('moveItem', () => {
  it('moves an item and ignores out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    const list = ['a', 'b'];
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 1, 2)).toBe(list);
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to device order and ignores junk values', () => {
    expect(loadChannelSortMode('src-a')).toBe('device');
    localStorage.setItem(channelSortModeKey('src-a'), 'bogus');
    expect(loadChannelSortMode('src-a')).toBe('device');
  });

  it('stores the mode and custom order per source', () => {
    saveChannelSortMode('src-a', 'name');
    saveChannelCustomOrder('src-a', [2, 0, 1]);
    expect(loadChannelSortMode('src-a')).toBe('name');
    expect(loadChannelCustomOrder('src-a')).toEqual([2, 0, 1]);
    expect(loadChannelSortMode('src-b')).toBe('device');
    expect(loadChannelCustomOrder('src-b')).toEqual([]);
  });

  it('sanitises a corrupt custom order', () => {
    localStorage.setItem(channelCustomOrderKey('src-a'), '{not json');
    expect(loadChannelCustomOrder('src-a')).toEqual([]);
    localStorage.setItem(channelCustomOrderKey('src-a'), JSON.stringify([1, 'x', 1, -2, 3.5, 0]));
    expect(loadChannelCustomOrder('src-a')).toEqual([1, 0]);
  });
});

describe('remapChannelCustomOrder (#5379)', () => {
  beforeEach(() => localStorage.clear());

  it('moves each saved slot to its new slot, per source', () => {
    saveChannelCustomOrder('a', [3, 0, 1, 2]);
    saveChannelCustomOrder('b', [1, 2]);
    remapChannelCustomOrder('a', [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]);
    expect(loadChannelCustomOrder('a')).toEqual([1, 0, 2, 3]);
    expect(loadChannelCustomOrder('b')).toEqual([1, 2]);
  });

  it('does not create an order when none was saved', () => {
    remapChannelCustomOrder('a', [{ from: 1, to: 2 }, { from: 2, to: 1 }]);
    expect(localStorage.getItem(channelCustomOrderKey('a'))).toBeNull();
  });
});
