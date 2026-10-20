/**
 * Tests for migration 215 — meshcore_nodes.advertSignatureVerified (#5909).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './215_add_meshcore_advert_signature_verified.js';

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

describe('Migration 215 — meshcore_nodes.advertSignatureVerified', () => {
  it('adds a nullable column and is idempotent', () => {
    const db = new Database(':memory:');
    createTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'advertSignatureVerified');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    expect(cols.filter((c) => c.name === 'advertSignatureVerified')).toHaveLength(1);
    db.close();
  });

  it('leaves existing rows NULL (never checked) and keeps their coordinates', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, latitude, longitude, createdAt, updatedAt)
      VALUES ('k', 'src-a', 45.5, -75.5, 1, 1)`).run();
    migration.up(db);
    expect(db.prepare(`SELECT latitude, longitude, advertSignatureVerified FROM meshcore_nodes`).get())
      .toEqual({ latitude: 45.5, longitude: -75.5, advertSignatureVerified: null });
    db.close();
  });

  it('stores false distinctly from NULL', () => {
    const db = new Database(':memory:');
    createTable(db);
    db.prepare(`INSERT INTO meshcore_nodes (publicKey, sourceId, createdAt, updatedAt) VALUES ('k', 'src-a', 1, 1)`).run();
    migration.up(db);
    db.prepare(`UPDATE meshcore_nodes SET advertSignatureVerified = 0`).run();
    expect(db.prepare(`SELECT advertSignatureVerified FROM meshcore_nodes`).get()).toEqual({ advertSignatureVerified: 0 });
    db.close();
  });
});
