/**
 * Tests for migration 206 — meshcore_nodes location override columns (#5842).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './206_add_meshcore_position_override.js';

const COLUMNS = [
  'positionOverrideEnabled',
  'latitudeOverride',
  'longitudeOverride',
  'altitudeOverride',
  'positionOverrideIsPrivate',
];

function createTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE meshcore_nodes (
      publicKey TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (sourceId, publicKey)
    );
  `);
}

describe('Migration 206 — meshcore_nodes position override columns', () => {
  it('adds all five columns once and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string; dflt_value: unknown }>;
    for (const name of COLUMNS) {
      expect(cols.filter((c) => c.name === name)).toHaveLength(1);
    }
    expect(cols.find((c) => c.name === 'positionOverrideEnabled')!.dflt_value).toBe('0');
    expect(cols.find((c) => c.name === 'positionOverrideIsPrivate')!.dflt_value).toBe('0');
    db.close();
  });

  it('leaves existing rows disabled and keeps their advert coordinates', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, latitude, longitude, createdAt, updatedAt)
      VALUES ('k', 'src-a', 45.5, -75.5, 1, 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT latitude, longitude, positionOverrideEnabled, latitudeOverride, longitudeOverride,
      altitudeOverride, positionOverrideIsPrivate FROM meshcore_nodes`).get()).toEqual({
      latitude: 45.5,
      longitude: -75.5,
      positionOverrideEnabled: 0,
      latitudeOverride: null,
      longitudeOverride: null,
      altitudeOverride: null,
      positionOverrideIsPrivate: 0,
    });
    db.close();
  });
});
