/**
 * Tests for migration 194 — meshcore_nodes.lastAdvertHadPosition (#5578).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './194_add_meshcore_last_advert_had_position.js';

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

describe('Migration 194 — meshcore_nodes.lastAdvertHadPosition', () => {
  it('adds a nullable column and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'lastAdvertHadPosition');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    expect(cols.filter((c) => c.name === 'lastAdvertHadPosition')).toHaveLength(1);
    db.close();
  });

  it('leaves existing rows NULL (unknown) and keeps their coordinates', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, latitude, longitude, createdAt, updatedAt)
      VALUES ('k', 'src-a', 45.5, -75.5, 1, 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT latitude, longitude, lastAdvertHadPosition FROM meshcore_nodes`).get())
      .toEqual({ latitude: 45.5, longitude: -75.5, lastAdvertHadPosition: null });
    db.close();
  });

  it('stores false distinctly from NULL', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt, updatedAt) VALUES ('k', 'src-a', 1, 1)`).run();
    migration.up(db);
    db.prepare(`UPDATE meshcore_nodes SET lastAdvertHadPosition = 0`).run();
    expect(db.prepare(`SELECT lastAdvertHadPosition FROM meshcore_nodes`).get()).toEqual({ lastAdvertHadPosition: 0 });
    db.close();
  });
});
