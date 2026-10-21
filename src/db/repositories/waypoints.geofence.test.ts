/**
 * WaypointsRepository geofence columns (#5922), against real SQLite built
 * from the waypoint migrations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WaypointsRepository } from './waypoints.js';
import { createSqliteBackend, type TestBackend } from './test-utils.js';
import { migration as m053 } from '../../server/migrations/053_create_waypoints.js';
import { migration as m130 } from '../../server/migrations/130_add_waypoint_channel.js';
import { migration as m183 } from '../../server/migrations/183_add_waypoint_hop_limit_automation_key.js';
import { migration as m216 } from '../../server/migrations/216_add_waypoint_geofence.js';

/** The waypoints DDL as the migrations leave it. */
function waypointDdl(): string {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sources (id TEXT PRIMARY KEY)');
  for (const m of [m053, m130, m183, m216]) m.up(db);
  const rows = db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL`).all() as { sql: string }[];
  db.close();
  return `${rows.map((r) => `${r.sql};`).join('\n')}\nINSERT INTO sources (id) VALUES ('src-a');`;
}

describe('WaypointsRepository geofence (SQLite)', () => {
  let backend: TestBackend;
  let repo: WaypointsRepository;

  beforeEach(() => {
    backend = createSqliteBackend(waypointDdl());
    repo = new WaypointsRepository(backend.drizzleDb, 'sqlite');
  });

  afterEach(async () => {
    await backend.close();
  });

  const base = { sourceId: 'src-a', waypointId: 1, latitude: 30, longitude: -90 };

  it('defaults to no geofence', async () => {
    const row = await repo.upsertAsync(base);
    expect(row).toMatchObject({
      geofenceRadiusM: null, boundingBox: null, notifyOnEnter: false, notifyOnExit: false, notifyFavoritesOnly: false,
    });
  });

  it('round-trips radius, box and flags', async () => {
    const row = await repo.upsertAsync({
      ...base,
      geofenceRadiusM: 500,
      boundingBox: { west: -90.1, south: 29.9, east: -89.9, north: 30.1 },
      notifyOnEnter: true,
      notifyOnExit: true,
      notifyFavoritesOnly: true,
    });
    expect(row).toMatchObject({
      geofenceRadiusM: 500,
      boundingBox: { west: -90.1, south: 29.9, east: -89.9, north: 30.1 },
      notifyOnEnter: true,
      notifyOnExit: true,
      notifyFavoritesOnly: true,
    });
  });

  it('keeps stored geofence fields when an upsert omits them, and clears them on null', async () => {
    await repo.upsertAsync({ ...base, geofenceRadiusM: 500, boundingBox: { west: 1, south: 2, east: 3, north: 4 }, notifyOnExit: true });
    const kept = await repo.upsertAsync({ ...base, name: 'renamed' });
    expect(kept).toMatchObject({ geofenceRadiusM: 500, boundingBox: { west: 1, south: 2, east: 3, north: 4 }, notifyOnExit: true });

    const cleared = await repo.upsertAsync({ ...base, geofenceRadiusM: null, boundingBox: null, notifyOnExit: false });
    expect(cleared).toMatchObject({ geofenceRadiusM: null, boundingBox: null, notifyOnExit: false });
  });
});
