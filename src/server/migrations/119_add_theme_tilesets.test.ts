import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { migration, runMigration119Mysql, runMigration119Postgres } from './119_add_theme_tilesets.js';

describe('Migration 119 — per-theme map tilesets', () => {
  it('backfills defaults and preserves customized legacy selections on SQLite', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE user_map_preferences (
        id INTEGER PRIMARY KEY,
        map_tileset TEXT
      );
      INSERT INTO user_map_preferences (id, map_tileset) VALUES
        (1, NULL),
        (2, 'osm'),
        (3, 'openTopo'),
        (4, 'custom-night');
    `);

    migration.up(db);
    migration.up(db);

    const rows = db.prepare(`
      SELECT id, map_tileset_light AS light, map_tileset_dark AS dark
      FROM user_map_preferences ORDER BY id
    `).all();

    expect(rows).toEqual([
      { id: 1, light: 'osm', dark: 'cartoDark' },
      { id: 2, light: 'osm', dark: 'cartoDark' },
      { id: 3, light: 'openTopo', dark: 'openTopo' },
      { id: 4, light: 'custom-night', dark: 'custom-night' },
    ]);
    db.close();
  });

  it('adds and backfills both PostgreSQL columns', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await runMigration119Postgres(client);

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[0][0]).toContain('map_tileset_light');
    expect(client.query.mock.calls[1][0]).toContain('map_tileset_dark');
    expect(client.query.mock.calls[2][0]).toContain("THEN 'cartoDark'");
  });

  it('adds missing MySQL columns and always runs the idempotent backfill', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([{}, []])
        .mockResolvedValueOnce([[{ COLUMN_NAME: 'map_tileset_dark' }], []])
        .mockResolvedValueOnce([{}, []]),
    } as any;

    await runMigration119Mysql(pool);

    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.query.mock.calls[1][0]).toContain('ADD COLUMN map_tileset_light');
    expect(pool.query.mock.calls.some(([sql]: [string]) => sql.includes('ADD COLUMN map_tileset_dark'))).toBe(false);
    expect(pool.query.mock.calls[3][0]).toContain('UPDATE user_map_preferences');
  });
});
