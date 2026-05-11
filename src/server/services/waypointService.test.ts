/**
 * waypointService unit tests
 *
 * Mocks the WaypointsRepository façade exposed via DatabaseService and
 * verifies upsert/delete semantics, the expire-tombstone convention, icon
 * decoding, locked-to enforcement, and the expire sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockUpsert,
  mockGet,
  mockDelete,
  mockList,
  mockGetExistingIds,
  mockSweep,
  mockFindOldestEligible,
  mockMarkRebroadcasted,
  mockGetManager,
  emit,
} = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockGet: vi.fn(),
  mockDelete: vi.fn(),
  mockList: vi.fn(),
  mockGetExistingIds: vi.fn(),
  mockSweep: vi.fn(),
  mockFindOldestEligible: vi.fn(),
  mockMarkRebroadcasted: vi.fn(),
  mockGetManager: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    waypoints: {
      upsertAsync: mockUpsert,
      getAsync: mockGet,
      deleteAsync: mockDelete,
      listAsync: mockList,
      getExistingIdsAsync: mockGetExistingIds,
      sweepExpiredAsync: mockSweep,
      findOldestEligibleForRebroadcastAsync: mockFindOldestEligible,
      markRebroadcastedAsync: mockMarkRebroadcasted,
    },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (...args: unknown[]) => mockGetManager(...args),
  },
}));

vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitWaypointUpserted: (...args: unknown[]) => emit('upserted', args),
    emitWaypointDeleted: (...args: unknown[]) => emit('deleted', args),
    emitWaypointExpired: (...args: unknown[]) => emit('expired', args),
  },
}));

import { waypointService, codepointToEmoji, emojiToCodepoint } from './waypointService.js';

beforeEach(() => {
  mockUpsert.mockReset();
  mockGet.mockReset();
  mockDelete.mockReset();
  mockList.mockReset();
  mockGetExistingIds.mockReset();
  mockSweep.mockReset();
  mockFindOldestEligible.mockReset();
  mockMarkRebroadcasted.mockReset();
  mockGetManager.mockReset();
  emit.mockReset();
});

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 's1',
    waypointId: 7,
    latitude: 1.23,
    longitude: 4.56,
    name: 'Camp',
    description: '',
    iconCodepoint: 0,
    iconEmoji: null,
    isVirtual: false,
    expireAt: null,
    lockedTo: 0,
    ownerNodeNum: 0,
    firstSeenAt: 1,
    lastUpdatedAt: 1,
    rebroadcastIntervalS: 600,
    lastBroadcastAt: null,
    ...overrides,
  };
}

describe('codepointToEmoji / emojiToCodepoint', () => {
  it('round-trips a basic emoji', () => {
    const cp = emojiToCodepoint('😀');
    expect(cp).toBe(0x1f600);
    expect(codepointToEmoji(cp)).toBe('😀');
  });

  it('returns null for 0 / invalid codepoints', () => {
    expect(codepointToEmoji(0)).toBeNull();
    expect(codepointToEmoji(0x110000)).toBeNull();
    expect(codepointToEmoji(undefined)).toBeNull();
  });
});

describe('upsertFromMesh', () => {
  it('persists, decodes icon, and emits waypoint:upserted', async () => {
    mockGet.mockResolvedValueOnce(null);
    mockUpsert.mockResolvedValueOnce({ sourceId: 's1', waypointId: 42 });
    const futureExpire = Math.floor(Date.now() / 1000) + 86400;
    const decoded = {
      id: 42,
      latitude_i: 300000000, // 30°
      longitude_i: -900000000, // -90°
      expire: futureExpire,
      locked_to: 0,
      name: 'Camp',
      description: 'Hideout',
      icon: 0x1f3d5, // 🏕️
    };

    const result = await waypointService.upsertFromMesh('s1', 555, decoded);

    expect(result).toEqual({ sourceId: 's1', waypointId: 42 });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 's1',
        waypointId: 42,
        ownerNodeNum: 555,
        latitude: 30,
        longitude: -90,
        expireAt: futureExpire,
        lockedTo: null,
        name: 'Camp',
        description: 'Hideout',
        iconCodepoint: 0x1f3d5,
        iconEmoji: expect.any(String),
        isVirtual: false,
      }),
    );
    expect(emit.mock.calls[0]?.[0]).toBe('upserted');
  });

  it('falls back to 📍 when icon codepoint is 0 or invalid', async () => {
    mockUpsert.mockResolvedValueOnce({ sourceId: 's1', waypointId: 1 });
    await waypointService.upsertFromMesh('s1', 1, {
      id: 1,
      latitude_i: 0,
      longitude_i: 0,
      expire: 0, // no expiration → upsert path
      icon: 0,
    });
    const args = mockUpsert.mock.calls[0]?.[0];
    expect(args.iconEmoji).toBe('\u{1F4CD}');
    expect(args.iconCodepoint).toBeNull();
  });

  it('treats a non-zero past expire as a delete tombstone and emits waypoint:deleted', async () => {
    mockDelete.mockResolvedValueOnce(true);
    const result = await waypointService.upsertFromMesh('s1', 9, {
      id: 7,
      latitude_i: 1,
      longitude_i: 1,
      expire: 1, // Apple-style tombstone: any non-zero past epoch
    });
    expect(result).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith('s1', 7);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(emit.mock.calls[0]?.[0]).toBe('deleted');
  });

  it('treats expire=0 as "no expiration" and upserts the waypoint', async () => {
    mockGet.mockResolvedValueOnce(null);
    mockUpsert.mockResolvedValueOnce({ sourceId: 's1', waypointId: 7 });
    const result = await waypointService.upsertFromMesh('s1', 9, {
      id: 7,
      latitude_i: 100000000,
      longitude_i: -800000000,
      expire: 0,
      name: 'No expiry',
    });
    expect(result).not.toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalled();
    expect(emit.mock.calls[0]?.[0]).toBe('upserted');
  });

  it('ignores packets without an id', async () => {
    const result = await waypointService.upsertFromMesh('s1', 1, { latitude_i: 0, longitude_i: 0 });
    expect(result).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('ignores packets without coordinates', async () => {
    mockGet.mockResolvedValueOnce(null);
    const result = await waypointService.upsertFromMesh('s1', 1, { id: 1, expire: 1 });
    expect(result).toBeNull();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe('createLocal / update / deleteLocal', () => {
  it('createLocal allocates an id and emits an upsert event', async () => {
    mockGetExistingIds.mockResolvedValueOnce(new Set<number>());
    mockGet.mockResolvedValueOnce(null);
    mockUpsert.mockResolvedValueOnce({ sourceId: 's1', waypointId: 1234 });

    const persisted = await waypointService.createLocal(
      's1',
      555,
      { latitude: 30, longitude: -90, name: 'Local', icon: '🏠' },
      { virtual: true },
    );

    expect(persisted.sourceId).toBe('s1');
    expect(mockUpsert).toHaveBeenCalled();
    const args = mockUpsert.mock.calls[0]?.[0];
    expect(args.isVirtual).toBe(true);
    expect(args.iconCodepoint).toBe(emojiToCodepoint('🏠'));
    expect(emit.mock.calls[0]?.[0]).toBe('upserted');
  });

  it('update refuses to modify a waypoint locked to a different node', async () => {
    mockGet.mockResolvedValueOnce({
      sourceId: 's1', waypointId: 1, lockedTo: 999, name: '', description: '',
      latitude: 0, longitude: 0, ownerNodeNum: 999, expireAt: null,
      iconCodepoint: null, iconEmoji: null, isVirtual: false,
      firstSeenAt: 1, lastUpdatedAt: 1, rebroadcastIntervalS: null, lastBroadcastAt: null,
    });

    await expect(
      waypointService.update('s1', 1, 555, { name: 'edit' }),
    ).rejects.toThrow(/locked to 999/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('deleteLocal honours lockedTo', async () => {
    mockGet.mockResolvedValueOnce({
      sourceId: 's1', waypointId: 1, lockedTo: 555, ownerNodeNum: 555,
      latitude: 0, longitude: 0, expireAt: null, name: '', description: '',
      iconCodepoint: null, iconEmoji: null, isVirtual: false,
      firstSeenAt: 1, lastUpdatedAt: 1, rebroadcastIntervalS: null, lastBroadcastAt: null,
    });
    mockDelete.mockResolvedValueOnce(true);

    const ok = await waypointService.deleteLocal('s1', 1, 555);
    expect(ok).toBe(true);
    expect(emit.mock.calls[0]?.[0]).toBe('deleted');
  });
});

describe('rebroadcastTick', () => {
  it('returns null when nothing is eligible', async () => {
    mockFindOldestEligible.mockResolvedValueOnce(null);
    const result = await waypointService.rebroadcastTick();
    expect(result).toBeNull();
    expect(mockMarkRebroadcasted).not.toHaveBeenCalled();
  });

  it('does NOT stamp lastBroadcastAt when no source manager is available', async () => {
    mockFindOldestEligible.mockResolvedValueOnce(eligibleRow());
    mockGetManager.mockReturnValueOnce(null);
    const result = await waypointService.rebroadcastTick();
    expect(result).toBeNull();
    expect(mockMarkRebroadcasted).not.toHaveBeenCalled();
  });

  it('does NOT stamp lastBroadcastAt when the manager returns a falsy packetId', async () => {
    mockFindOldestEligible.mockResolvedValueOnce(eligibleRow());
    mockGetManager.mockReturnValueOnce({ broadcastWaypoint: vi.fn().mockResolvedValue(0) });
    const result = await waypointService.rebroadcastTick();
    expect(result).toBeNull();
    expect(mockMarkRebroadcasted).not.toHaveBeenCalled();
  });

  it('does NOT stamp lastBroadcastAt when broadcastWaypoint throws', async () => {
    mockFindOldestEligible.mockResolvedValueOnce(eligibleRow());
    mockGetManager.mockReturnValueOnce({
      broadcastWaypoint: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await waypointService.rebroadcastTick();
    expect(result).toBeNull();
    expect(mockMarkRebroadcasted).not.toHaveBeenCalled();
  });

  it('stamps lastBroadcastAt and emits upserted on a successful broadcast', async () => {
    const row = eligibleRow();
    mockFindOldestEligible.mockResolvedValueOnce(row);
    const broadcastWaypoint = vi.fn().mockResolvedValue(42);
    mockGetManager.mockReturnValueOnce({ broadcastWaypoint });
    mockMarkRebroadcasted.mockResolvedValueOnce(true);
    const refreshed = { ...row, lastBroadcastAt: 1234 };
    mockGet.mockResolvedValueOnce(refreshed);

    const result = await waypointService.rebroadcastTick();

    expect(broadcastWaypoint).toHaveBeenCalledOnce();
    expect(mockMarkRebroadcasted).toHaveBeenCalledWith('s1', 7, expect.any(Number));
    expect(result).toEqual(refreshed);
    expect(emit.mock.calls.find((c) => c[0] === 'upserted')).toBeTruthy();
  });
});

describe('expireSweep', () => {
  it('emits waypoint:expired for each removed row and returns the count', async () => {
    mockSweep.mockResolvedValueOnce([
      { sourceId: 's1', waypointId: 1 },
      { sourceId: 's2', waypointId: 2 },
    ]);
    const removed = await waypointService.expireSweep(3600);
    expect(removed).toBe(2);
    expect(emit.mock.calls.filter((c) => c[0] === 'expired').length).toBe(2);
  });
});
