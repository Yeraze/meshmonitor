/**
 * Migration 057 — Add sourceId to meshcore tables and seed a legacy default
 * source for any pre-existing rows. SQLite-only test; the Postgres / MySQL
 * paths share the same shape and are exercised by the integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './057_add_source_id_to_meshcore_tables.js';

const LEGACY_SOURCE_ID = 'meshcore-legacy-default';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      createdBy INTEGER
    );
    CREATE TABLE meshcore_nodes (
      publicKey TEXT PRIMARY KEY,
      name TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE meshcore_messages (
      id TEXT PRIMARY KEY,
      fromPublicKey TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
}

function insertNode(db: Database.Database, pk: string) {
  const ts = Date.now();
  db.prepare(`INSERT INTO meshcore_nodes (publicKey, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)`)
    .run(pk, `node-${pk}`, ts, ts);
}

function insertMessage(db: Database.Database, id: string) {
  const ts = Date.now();
  db.prepare(
    `INSERT INTO meshcore_messages (id, fromPublicKey, text, timestamp, createdAt) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'pubkey', 'hi', ts, ts);
}

describe('Migration 057 — add sourceId to meshcore tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('adds sourceId column + index to both meshcore tables', () => {
    migration.up(db);

    const nodeCols = db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as Array<{ name: string }>;
    const msgCols = db.prepare(`PRAGMA table_info(meshcore_messages)`).all() as Array<{ name: string }>;
    expect(nodeCols.some((c) => c.name === 'sourceId')).toBe(true);
    expect(msgCols.some((c) => c.name === 'sourceId')).toBe(true);

    const indexes = db.prepare(`PRAGMA index_list('meshcore_nodes')`).all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === 'idx_meshcore_nodes_source_id')).toBe(true);
  });

  it('does not seed a legacy source when no rows exist', () => {
    migration.up(db);

    const sources = db.prepare(`SELECT id FROM sources`).all() as Array<{ id: string }>;
    expect(sources).toHaveLength(0);
  });

  it('seeds the legacy default source and backfills NULL-sourceId rows', () => {
    insertNode(db, 'pk-1');
    insertNode(db, 'pk-2');
    insertMessage(db, 'msg-1');

    migration.up(db);

    const legacy = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(LEGACY_SOURCE_ID) as any;
    expect(legacy).toBeDefined();
    expect(legacy.type).toBe('meshcore');
    expect(legacy.name).toBe('MeshCore (legacy)');
    expect(legacy.enabled).toBe(0);
    const cfg = JSON.parse(legacy.config);
    expect(cfg).toEqual({ transport: 'usb', port: '', deviceType: 'companion' });

    const nodes = db.prepare(`SELECT publicKey, sourceId FROM meshcore_nodes`).all() as Array<{
      publicKey: string;
      sourceId: string | null;
    }>;
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.sourceId === LEGACY_SOURCE_ID)).toBe(true);

    const msgs = db.prepare(`SELECT id, sourceId FROM meshcore_messages`).all() as Array<{
      id: string;
      sourceId: string | null;
    }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sourceId).toBe(LEGACY_SOURCE_ID);
  });

  it('is idempotent — re-running does not duplicate the legacy source or change rows', () => {
    insertNode(db, 'pk-1');
    migration.up(db);
    migration.up(db);

    const sources = db.prepare(`SELECT id FROM sources WHERE id = ?`).all(LEGACY_SOURCE_ID);
    expect(sources).toHaveLength(1);

    const nodes = db.prepare(`SELECT sourceId FROM meshcore_nodes`).all() as Array<{ sourceId: string }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sourceId).toBe(LEGACY_SOURCE_ID);
  });

  it('does not touch rows that already have a sourceId set', () => {
    insertNode(db, 'pk-1');
    insertNode(db, 'pk-2');
    migration.up(db); // first pass — both backfilled to legacy default

    // Manually re-stamp pk-2 to a different source
    db.prepare(`UPDATE meshcore_nodes SET sourceId = 'some-other-src' WHERE publicKey = 'pk-2'`).run();

    migration.up(db);

    const pk2 = db.prepare(`SELECT sourceId FROM meshcore_nodes WHERE publicKey = 'pk-2'`).get() as { sourceId: string };
    expect(pk2.sourceId).toBe('some-other-src');
  });
});
