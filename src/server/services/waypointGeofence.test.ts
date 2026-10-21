/**
 * Waypoint geofence fields (#5922): decode, the broadcast payload, and the
 * protobuf round trip through createWaypointMessage.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));

import meshtasticProtobufService from '../meshtasticProtobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';
import { decodeWaypointGeofence, toWireWaypoint } from './waypointGeofence.js';
import type { Waypoint } from '../../db/repositories/waypoints.js';

/** Encode through createWaypointMessage, then decode the Waypoint payload back. */
function roundTrip(wire: Parameters<typeof meshtasticProtobufService.createWaypointMessage>[0]) {
  const root = getProtobufRoot()!;
  const { data } = meshtasticProtobufService.createWaypointMessage(wire);
  const toRadio = root.lookupType('meshtastic.ToRadio').decode(data) as any;
  const payload = toRadio.packet.decoded.payload as Uint8Array;
  return { payload, waypoint: root.lookupType('meshtastic.Waypoint').decode(payload) as any };
}

const ROW: Waypoint = {
  sourceId: 's1', waypointId: 42, ownerNodeNum: 1, latitude: 30.5, longitude: -90.25,
  expireAt: null, lockedTo: null, name: 'Camp', description: '', iconCodepoint: 0x1f3d5, iconEmoji: null,
  isVirtual: false, channel: 0, rebroadcastIntervalS: null, hopLimit: null, automationKey: null,
  broadcastFingerprint: null, lastBroadcastAt: null, firstSeenAt: 0, lastUpdatedAt: 0,
  geofenceRadiusM: null, boundingBox: null, notifyOnEnter: false, notifyOnExit: false, notifyFavoritesOnly: false,
};

describe('decodeWaypointGeofence', () => {
  it('reads camelCase fields', () => {
    expect(decodeWaypointGeofence({
      geofenceRadius: 500,
      boundingBox: { longitudeWestI: -900_000_000, latitudeSouthI: 300_000_000, longitudeEastI: -899_000_000, latitudeNorthI: 301_000_000 },
      notifyOnEnter: true,
      notifyFavoritesOnly: true,
    })).toEqual({
      geofenceRadiusM: 500,
      boundingBox: { west: -90, south: 30, east: -89.9, north: 30.1 },
      notifyOnEnter: true,
      notifyOnExit: false,
      notifyFavoritesOnly: true,
    });
  });

  it('reads snake_case fields', () => {
    const g = decodeWaypointGeofence({ geofence_radius: 1000, notify_on_exit: true });
    expect(g.geofenceRadiusM).toBe(1000);
    expect(g.notifyOnExit).toBe(true);
  });

  it('treats absent fields, radius 0 and an all-zero box as no geofence', () => {
    const none = { geofenceRadiusM: null, boundingBox: null, notifyOnEnter: false, notifyOnExit: false, notifyFavoritesOnly: false };
    expect(decodeWaypointGeofence({})).toEqual(none);
    expect(decodeWaypointGeofence({
      geofenceRadius: 0,
      boundingBox: { longitudeWestI: 0, latitudeSouthI: 0, longitudeEastI: 0, latitudeNorthI: 0 },
    })).toEqual(none);
  });
});

describe('createWaypointMessage geofence fields (#5922)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('encodes radius, box and flags so they decode back the same', () => {
    const { waypoint } = roundTrip(toWireWaypoint({
      ...ROW,
      geofenceRadiusM: 750,
      boundingBox: { west: -90.3, south: 30.4, east: -90.2, north: 30.6 },
      notifyOnEnter: true,
      notifyOnExit: true,
      notifyFavoritesOnly: true,
    }));
    expect(waypoint.geofenceRadius).toBe(750);
    expect(waypoint.boundingBox).toMatchObject({
      longitudeWestI: -903_000_000, latitudeSouthI: 304_000_000, longitudeEastI: -902_000_000, latitudeNorthI: 306_000_000,
    });
    expect(waypoint.notifyOnEnter).toBe(true);
    expect(waypoint.notifyOnExit).toBe(true);
    expect(waypoint.notifyFavoritesOnly).toBe(true);
    expect(decodeWaypointGeofence(waypoint)).toEqual({
      geofenceRadiusM: 750,
      boundingBox: { west: -90.3, south: 30.4, east: -90.2, north: 30.6 },
      notifyOnEnter: true,
      notifyOnExit: true,
      notifyFavoritesOnly: true,
    });
  });

  it('encodes a waypoint without a geofence exactly as before', () => {
    const { payload, waypoint } = roundTrip(toWireWaypoint(ROW));
    const legacy = getProtobufRoot()!.lookupType('meshtastic.Waypoint');
    const before = legacy.encode(legacy.create({
      id: 42, latitudeI: 305_000_000, longitudeI: -902_500_000, expire: 0, lockedTo: 0,
      name: 'Camp', description: '', icon: 0x1f3d5,
    })).finish();
    expect(Buffer.from(payload).equals(Buffer.from(before))).toBe(true);
    expect(waypoint.boundingBox ?? null).toBeNull();
  });
});
