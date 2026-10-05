/**
 * Waypoint arrival notifications (#4750).
 *
 * The three rules that keep this feature from becoming a notification storm
 * are what these tests are for: only mesh-received waypoints alert, the radius
 * is measured per user and fails CLOSED when there is no reference point, and
 * dedupe on waypoint id is persisted so a rebroadcast stays silent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUsersWithWaypointNotifications = vi.fn();
const getNotifiedUserIdsAsync = vi.fn();
const markNotifiedAsync = vi.fn();
const clearForWaypointAsync = vi.fn();
const getNode = vi.fn();
const getSource = vi.fn();
const broadcastToPreferenceUsers = vi.fn();
const getManager = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    notifications: { getUsersWithWaypointNotifications: () => getUsersWithWaypointNotifications() },
    waypointNotifications: {
      getNotifiedUserIdsAsync: (...a: unknown[]) => getNotifiedUserIdsAsync(...a),
      markNotifiedAsync: (...a: unknown[]) => markNotifiedAsync(...a),
      clearForWaypointAsync: (...a: unknown[]) => clearForWaypointAsync(...a),
    },
    nodes: { getNode: (...a: unknown[]) => getNode(...a) },
    sources: { getSource: (...a: unknown[]) => getSource(...a) },
  },
}));

vi.mock('./notificationService.js', () => ({
  notificationService: {
    broadcastToPreferenceUsers: (...a: unknown[]) => broadcastToPreferenceUsers(...a),
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (...a: unknown[]) => getManager(...a) },
}));

import { waypointNotificationService, resolveUserSettings } from './waypointNotificationService.js';

const SOURCE = 'src-a';

/** Fort Lauderdale-ish, and a point ~6 km away, and one ~110 km away. */
const CENTER = { lat: 26.12, lon: -80.14 };
const NEAR = { lat: 26.17, lon: -80.14 };
const waypointAt = (latitude: number, longitude: number, waypointId = 42) => ({
  waypointId,
  latitude,
  longitude,
  name: 'MEETUP',
  description: 'bring water',
  iconEmoji: '📍',
});

const prefRow = (over: Partial<{
  userId: number; sourceId: string; notifyOnWaypoint: boolean;
  waypointRadiusKm: number | null; waypointCenterLat: number | null; waypointCenterLon: number | null;
}> = {}) => ({
  userId: 1,
  sourceId: SOURCE,
  notifyOnWaypoint: true,
  waypointRadiusKm: 10,
  waypointCenterLat: CENTER.lat,
  waypointCenterLon: CENTER.lon,
  ...over,
});

describe('resolveUserSettings', () => {
  it('drops a user whose every row has the flag off', () => {
    expect(resolveUserSettings([prefRow({ notifyOnWaypoint: false })], SOURCE)).toEqual([]);
  });

  // No cross-source borrowing: only the row saved for the waypoint's own
  // source counts. (These three used to assert the opposite — "any row true",
  // values from the '' row or the user's first row.)
  it('does not alert on a source whose own row has the flag off, whatever another row says', () => {
    const rows = [
      prefRow({ sourceId: '', notifyOnWaypoint: true, waypointRadiusKm: 3 }),
      prefRow({ sourceId: 'other-source', notifyOnWaypoint: true, waypointRadiusKm: 500 }),
      prefRow({ sourceId: SOURCE, notifyOnWaypoint: false, waypointRadiusKm: 25 }),
    ];
    expect(resolveUserSettings(rows, SOURCE)).toEqual([]);
  });

  it('does not alert on a source the user never configured', () => {
    const rows = [
      prefRow({ sourceId: 'other-source', notifyOnWaypoint: true, waypointRadiusKm: 500, waypointCenterLat: 1, waypointCenterLon: 2 }),
      prefRow({ sourceId: '', notifyOnWaypoint: true, waypointRadiusKm: 3 }),
    ];
    expect(resolveUserSettings(rows, SOURCE)).toEqual([]);
  });

  it('measures with the exact source row, never another row of the same user', () => {
    const rows = [
      prefRow({ sourceId: 'a-first-by-sort', notifyOnWaypoint: true, waypointRadiusKm: 500, waypointCenterLat: 1, waypointCenterLon: 2 }),
      prefRow({ sourceId: SOURCE, notifyOnWaypoint: true, waypointRadiusKm: 25, waypointCenterLat: null, waypointCenterLon: null }),
    ];
    expect(resolveUserSettings(rows, SOURCE)).toEqual([
      { userId: 1, radiusKm: 25, centerLat: null, centerLon: null },
    ]);
    // And the other source still resolves from its own row.
    expect(resolveUserSettings(rows, 'a-first-by-sort')).toEqual([
      { userId: 1, radiusKm: 500, centerLat: 1, centerLon: 2 },
    ]);
  });

  it('substitutes the default radius for a null or non-positive one', () => {
    expect(resolveUserSettings([prefRow({ waypointRadiusKm: null })], SOURCE)[0].radiusKm).toBe(10);
    expect(resolveUserSettings([prefRow({ waypointRadiusKm: 0 })], SOURCE)[0].radiusKm).toBe(10);
  });

  it('treats a half-set centre as unset rather than measuring from the equator', () => {
    const [resolved] = resolveUserSettings([prefRow({ waypointCenterLon: null })], SOURCE);
    expect(resolved.centerLat).toBeNull();
    expect(resolved.centerLon).toBeNull();
  });
});

describe('waypointNotificationService.notifyIfInRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUsersWithWaypointNotifications.mockResolvedValue([prefRow()]);
    getNotifiedUserIdsAsync.mockResolvedValue(new Set<number>());
    markNotifiedAsync.mockResolvedValue(undefined);
    getSource.mockResolvedValue({ name: 'Sandbox' });
    getManager.mockReturnValue({ getLocalNodeInfo: () => ({ nodeNum: 7 }) });
    getNode.mockResolvedValue({ latitude: CENTER.lat, longitude: CENTER.lon });
    broadcastToPreferenceUsers.mockResolvedValue({ sent: 1, failed: 0, filtered: 0 });
  });

  it('a user who opted in on source A is not alerted for a waypoint on source B, and still is on A', async () => {
    // The only row is for SOURCE. A waypoint on another source finds no row
    // for that source, so the built-in default applies: waypoint alerts off.
    getUsersWithWaypointNotifications.mockResolvedValue([prefRow({ sourceId: SOURCE, waypointRadiusKm: 20000 })]);

    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), 'never-configured-source');
    expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
    expect(markNotifiedAsync).not.toHaveBeenCalled();

    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
  });

  it('notifies for a waypoint inside the radius', async () => {
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    const [key, payload, userId] = broadcastToPreferenceUsers.mock.calls[0];
    expect(key).toBe('notifyOnWaypoint');
    expect(userId).toBe(1);
    expect(payload.title).toContain('MEETUP');
    // The source is named once, on the body (#5593).
    expect(payload.title).not.toContain('Sandbox');
    expect(`${payload.title}\n${payload.body}`.split('Sandbox')).toHaveLength(2);
  });

  it('stays silent for a waypoint outside the radius', async () => {
    // ~110 km north — well outside the 10 km default.
    await waypointNotificationService.notifyIfInRange(waypointAt(27.11, -80.14), SOURCE);
    expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
    expect(markNotifiedAsync).not.toHaveBeenCalled();
  });

  it('records the alert so the same waypoint id never alerts twice', async () => {
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(markNotifiedAsync).toHaveBeenCalledWith(1, SOURCE, 42);
  });

  it('stays silent on a rebroadcast the ledger already knows about', async () => {
    getNotifiedUserIdsAsync.mockResolvedValue(new Set([1]));
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
  });

  it('alerts again for a DIFFERENT waypoint id at the same place', async () => {
    // A waypoint that "moved" is a recreated one with a fresh id, and the
    // ledger is keyed on the id alone, so it is new.
    getNotifiedUserIdsAsync.mockResolvedValue(new Set<number>());
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon, 43), SOURCE);
    expect(broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    expect(markNotifiedAsync).toHaveBeenCalledWith(1, SOURCE, 43);
  });

  it('does nothing at all when nobody has opted in', async () => {
    getUsersWithWaypointNotifications.mockResolvedValue([]);
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(getNode).not.toHaveBeenCalled();
    expect(getSource).not.toHaveBeenCalled();
    expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
  });

  describe('reference point', () => {
    it("uses the source's own node when the user set no centre", async () => {
      getUsersWithWaypointNotifications.mockResolvedValue([
        prefRow({ waypointCenterLat: null, waypointCenterLon: null }),
      ]);
      await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
      expect(getNode).toHaveBeenCalledWith(7, SOURCE);
      expect(broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    });

    it("prefers the user's centre over the node, and skips the node lookup entirely", async () => {
      await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
      expect(getNode).not.toHaveBeenCalled();
    });

    it('fails CLOSED when there is no centre and the node has no position', async () => {
      getUsersWithWaypointNotifications.mockResolvedValue([
        prefRow({ waypointCenterLat: null, waypointCenterLon: null }),
      ]);
      getNode.mockResolvedValue({ latitude: null, longitude: null });
      await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
      // Alerting here would mean every waypoint on the mesh, which is exactly
      // what the radius exists to prevent.
      expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
    });

    it('fails CLOSED when the source has no manager registered', async () => {
      getUsersWithWaypointNotifications.mockResolvedValue([
        prefRow({ waypointCenterLat: null, waypointCenterLon: null }),
      ]);
      getManager.mockReturnValue(undefined);
      await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
      expect(broadcastToPreferenceUsers).not.toHaveBeenCalled();
    });
  });

  it('filters per user, so one user in range does not alert another out of range', async () => {
    getUsersWithWaypointNotifications.mockResolvedValue([
      prefRow({ userId: 1, waypointRadiusKm: 10 }),
      prefRow({ userId: 2, waypointRadiusKm: 1 }),
    ]);
    await waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE);
    expect(broadcastToPreferenceUsers).toHaveBeenCalledTimes(1);
    expect(broadcastToPreferenceUsers.mock.calls[0][2]).toBe(1);
  });

  it('falls back to the waypoint id for a nameless waypoint', async () => {
    const nameless = { ...waypointAt(NEAR.lat, NEAR.lon), name: '', description: '' };
    await waypointNotificationService.notifyIfInRange(nameless, SOURCE);
    const payload = broadcastToPreferenceUsers.mock.calls[0][1];
    expect(payload.title).toContain('Waypoint 42');
    expect(payload.body).toContain('26.17');
  });

  it('swallows a failure rather than breaking waypoint ingest', async () => {
    getUsersWithWaypointNotifications.mockRejectedValue(new Error('db down'));
    await expect(
      waypointNotificationService.notifyIfInRange(waypointAt(NEAR.lat, NEAR.lon), SOURCE),
    ).resolves.toBeUndefined();
  });
});
