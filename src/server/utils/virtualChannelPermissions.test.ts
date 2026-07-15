/**
 * Unit tests for the shared virtual-channel (Channel Database) read-permission
 * helpers. These are the single source of truth consulted by the unified
 * routes, the legacy per-source `/api/messages*` endpoints, and the
 * channel-database list handler, so their correctness gates every surface that
 * decides whether a virtual channel is readable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import databaseService from '../../services/database.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannel,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  virtualChannelDbId,
  hasAnyReadableVirtualChannel,
} from './virtualChannelPermissions.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isVirtualChannelNumber / virtualChannelDbId', () => {
  it('treats slots >= CHANNEL_DB_OFFSET as virtual and maps back to the db id', () => {
    expect(isVirtualChannelNumber(0)).toBe(false);
    expect(isVirtualChannelNumber(7)).toBe(false);
    expect(isVirtualChannelNumber(-1)).toBe(false); // DM sentinel
    expect(isVirtualChannelNumber(CHANNEL_DB_OFFSET)).toBe(true);
    expect(isVirtualChannelNumber(CHANNEL_DB_OFFSET + 5)).toBe(true);
    expect(virtualChannelDbId(CHANNEL_DB_OFFSET + 5)).toBe(5);
    expect(virtualChannelDbId(CHANNEL_DB_OFFSET)).toBe(0);
  });
});

describe('canReadVirtualChannel / canReadVirtualChannelNumber', () => {
  it('admin sentinel "all" reads everything', () => {
    expect(canReadVirtualChannel(3, 'all')).toBe(true);
    expect(canReadVirtualChannelNumber(CHANNEL_DB_OFFSET + 99, 'all')).toBe(true);
  });

  it('a Set grants only the ids it contains', () => {
    const readable = new Set([2, 5]);
    expect(canReadVirtualChannel(2, readable)).toBe(true);
    expect(canReadVirtualChannel(3, readable)).toBe(false);
    // by synthetic channel number
    expect(canReadVirtualChannelNumber(CHANNEL_DB_OFFSET + 5, readable)).toBe(true);
    expect(canReadVirtualChannelNumber(CHANNEL_DB_OFFSET + 3, readable)).toBe(false);
  });

  it('an empty Set grants nothing', () => {
    expect(canReadVirtualChannel(0, new Set())).toBe(false);
    expect(canReadVirtualChannelNumber(CHANNEL_DB_OFFSET, new Set())).toBe(false);
  });
});

describe('hasAnyReadableVirtualChannel', () => {
  it('is true for "all" and non-empty sets, false for empty', () => {
    expect(hasAnyReadableVirtualChannel('all')).toBe(true);
    expect(hasAnyReadableVirtualChannel(new Set([1]))).toBe(true);
    expect(hasAnyReadableVirtualChannel(new Set())).toBe(false);
  });
});

describe('getUserReadableVirtualChannelIds', () => {
  it('returns "all" for admins without touching the DB', async () => {
    const spy = vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync');
    const result = await getUserReadableVirtualChannelIds({ id: 1 }, true);
    expect(result).toBe('all');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns an empty set for anonymous/undefined user', async () => {
    const result = await getUserReadableVirtualChannelIds(undefined, false);
    expect(result).toEqual(new Set());
  });

  it('returns only the ids with canRead=true', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockResolvedValue([
      { userId: 7, channelDatabaseId: 1, canViewOnMap: false, canRead: true } as any,
      { userId: 7, channelDatabaseId: 2, canViewOnMap: true, canRead: false } as any,
      { userId: 7, channelDatabaseId: 3, canViewOnMap: false, canRead: true } as any,
    ]);
    const result = await getUserReadableVirtualChannelIds({ id: 7 }, false);
    expect(result).toEqual(new Set([1, 3]));
  });

  it('fails safe (empty set) when the permission lookup throws', async () => {
    vi.spyOn(databaseService.channelDatabase, 'getPermissionsForUserAsync').mockRejectedValue(
      new Error('db down'),
    );
    const result = await getUserReadableVirtualChannelIds({ id: 7 }, false);
    expect(result).toEqual(new Set());
  });
});
