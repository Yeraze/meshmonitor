/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCustomOrder,
  sortChannels,
  sortItems,
  moveItem,
  loadChannelSortMode,
  saveChannelSortMode,
  loadChannelCustomOrder,
  saveChannelCustomOrder,
  channelCustomOrderKey,
  channelSortModeKey,
  remapChannelCustomOrder,
  loadRoomSortMode,
  saveRoomSortMode,
  loadRoomCustomOrder,
  saveRoomCustomOrder,
  roomSortModeKey,
  roomCustomOrderKey,
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

  it('message count puts the busiest first and empty channels last, in slot order (#5503)', () => {
    const counts = { 2: 40, 0: 7, 3: 40 };
    expect(ids(sortChannels(channels, 'messageCount', { counts }))).toEqual([2, 3, 0, 1]);
  });

  it('message count with no counts falls back to slot order', () => {
    expect(ids(sortChannels(channels, 'messageCount'))).toEqual([0, 1, 2, 3]);
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

  it('round-trips the messageCount mode (#5503)', () => {
    saveChannelSortMode('src-x', 'messageCount');
    expect(loadChannelSortMode('src-x')).toBe('messageCount');
  });

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

// --- String-keyed items: the Rooms list keys on publicKey (#6148) ---

const room = (id: string, name: string) => ({ id, name });
const rids = (list: { id: string }[]) => list.map(r => r.id);

// pk ids chosen so id order != name order, to prove each sort is distinct.
const rooms = [
  room('pkC', 'zulu'),
  room('pkA', 'Alpha'),
  room('pkD', ''),
  room('pkB', 'mike'),
];

describe('sortItems with string ids (rooms)', () => {
  it('name order collates by display name, case-insensitive (empty name first)', () => {
    expect(rids(sortItems(rooms, 'name'))).toEqual(['pkD', 'pkA', 'pkB', 'pkC']);
  });

  it('last message puts newest first, silent rooms last by id order', () => {
    const latest = { pkC: 500, pkA: 900 };
    expect(rids(sortItems(rooms, 'lastMessage', { latest }))).toEqual(['pkA', 'pkC', 'pkB', 'pkD']);
  });

  it('message count puts the busiest first, empty rooms last by id order', () => {
    const counts = { pkC: 40, pkA: 7, pkD: 40 };
    expect(rids(sortItems(rooms, 'messageCount', { counts }))).toEqual(['pkC', 'pkD', 'pkA', 'pkB']);
  });

  it('distance puts nearest first; no-location rooms sink, ordered by name', () => {
    const distances = { pkC: 5, pkA: 20 };
    // pkC(5) < pkA(20) first; then no-location pkB('mike') and pkD('') by name
    // → '' before 'mike'.
    expect(rids(sortItems(rooms, 'distance', { distances }))).toEqual(['pkC', 'pkA', 'pkD', 'pkB']);
  });

  it('distance with no distances at all falls back to name order (no self fix)', () => {
    expect(rids(sortItems(rooms, 'distance', {}))).toEqual(['pkD', 'pkA', 'pkB', 'pkC']);
  });

  it('custom order follows the saved order and appends unknown rooms by id', () => {
    expect(rids(sortItems(rooms, 'custom', { customOrder: ['pkD', 'pkB'] })))
      .toEqual(['pkD', 'pkB', 'pkA', 'pkC']); // named first; rest by id order
  });

  it('applyCustomOrder appends rooms missing from the order and drops stale ids', () => {
    expect(rids(applyCustomOrder(rooms, ['zzz', 'pkC', 'pkA'])))
      .toEqual(['pkC', 'pkA', 'pkB', 'pkD']); // named first, rest by id order
  });
});

describe('room persistence (#6148)', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to name order and ignores junk / channel-only values', () => {
    expect(loadRoomSortMode('src-a')).toBe('name');
    localStorage.setItem(roomSortModeKey('src-a'), 'bogus');
    expect(loadRoomSortMode('src-a')).toBe('name');
    // 'device' is a channel-only mode and is not valid for rooms.
    localStorage.setItem(roomSortModeKey('src-a'), 'device');
    expect(loadRoomSortMode('src-a')).toBe('name');
  });

  it('round-trips the mode and the string custom order per source', () => {
    saveRoomSortMode('src-a', 'distance');
    saveRoomCustomOrder('src-a', ['pkB', 'pkA']);
    expect(loadRoomSortMode('src-a')).toBe('distance');
    expect(loadRoomCustomOrder('src-a')).toEqual(['pkB', 'pkA']);
    // A different source is untouched.
    expect(loadRoomSortMode('src-b')).toBe('name');
    expect(loadRoomCustomOrder('src-b')).toEqual([]);
  });

  it('uses a different localStorage key from the channel order', () => {
    expect(roomCustomOrderKey('s')).not.toBe(channelCustomOrderKey('s'));
    expect(roomSortModeKey('s')).not.toBe(channelSortModeKey('s'));
  });

  it('sanitises a corrupt custom order and dedupes', () => {
    localStorage.setItem(roomCustomOrderKey('src-a'), '{not json');
    expect(loadRoomCustomOrder('src-a')).toEqual([]);
    localStorage.setItem(roomCustomOrderKey('src-a'), JSON.stringify(['pkA', 1, '', 'pkA', 'pkB']));
    expect(loadRoomCustomOrder('src-a')).toEqual(['pkA', 'pkB']);
  });
});

describe('sortChannels stays a channel-flavoured alias of sortItems', () => {
  it('is the same function', () => {
    expect(sortChannels).toBe(sortItems);
  });
});
