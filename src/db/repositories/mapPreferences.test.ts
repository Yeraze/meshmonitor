/**
 * Regression test for issue #2713.
 *
 * The SQLite baseline (migration 001) creates `user_map_preferences` with
 * `user_id` (snake_case), matching every other SQLite table's FK convention.
 * Drizzle's SQLite schema for this table must therefore map the JS `userId`
 * property to the physical column `user_id` — otherwise every page load that
 * fetches map preferences logs:
 *   SqliteError: no such column: userId
 *
 * (The repo's getMapPreferences catches and swallows the error, so we can't
 * observe it by call result. Pin the schema mapping instead.)
 */
import { describe, it, expect } from 'vitest';
import * as schema from '../schema/index.js';

describe('userMapPreferencesSqlite — SQL column alignment (#2713)', () => {
  it('maps JS `userId` → SQL column `user_id` to match v3.7 baseline DDL', () => {
    const col = (schema.userMapPreferencesSqlite as unknown as {
      userId: { name: string };
    }).userId;
    expect(col.name).toBe('user_id');
  });
});

describe('userMapPreferences — showWaypoints toggle (#3253)', () => {
  it('maps JS `showWaypoints` → SQL column `show_waypoints` on all three backends', () => {
    const sqlite = (schema.userMapPreferencesSqlite as unknown as {
      showWaypoints: { name: string };
    }).showWaypoints;
    const pg = (schema.userMapPreferencesPostgres as unknown as {
      showWaypoints: { name: string };
    }).showWaypoints;
    const mysql = (schema.userMapPreferencesMysql as unknown as {
      showWaypoints: { name: string };
    }).showWaypoints;
    expect(sqlite.name).toBe('show_waypoints');
    expect(pg.name).toBe('show_waypoints');
    expect(mysql.name).toBe('show_waypoints');
  });
});

describe('userMapPreferences — positionHistoryPointsOnly toggle (#3492)', () => {
  it('maps JS `positionHistoryPointsOnly` → SQL column `position_history_points_only` on all three backends', () => {
    const sqlite = (schema.userMapPreferencesSqlite as unknown as {
      positionHistoryPointsOnly: { name: string };
    }).positionHistoryPointsOnly;
    const pg = (schema.userMapPreferencesPostgres as unknown as {
      positionHistoryPointsOnly: { name: string };
    }).positionHistoryPointsOnly;
    const mysql = (schema.userMapPreferencesMysql as unknown as {
      positionHistoryPointsOnly: { name: string };
    }).positionHistoryPointsOnly;
    expect(sqlite.name).toBe('position_history_points_only');
    expect(pg.name).toBe('position_history_points_only');
    expect(mysql.name).toBe('position_history_points_only');
  });
});

describe('userMapPreferences — per-theme tilesets (#4096)', () => {
  it('maps both themed fields to snake_case columns on all three backends', () => {
    for (const table of [
      schema.userMapPreferencesSqlite,
      schema.userMapPreferencesPostgres,
      schema.userMapPreferencesMysql,
    ]) {
      const columns = table as unknown as {
        mapTilesetLight: { name: string };
        mapTilesetDark: { name: string };
      };
      expect(columns.mapTilesetLight.name).toBe('map_tileset_light');
      expect(columns.mapTilesetDark.name).toBe('map_tileset_dark');
    }
  });
});
