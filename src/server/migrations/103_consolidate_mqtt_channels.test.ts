/**
 * Migration 103 — consolidate MQTT channels by name.
 *
 * Seeds the observed split scenario (duplicate channel_database rows, hash-keyed
 * MQTT channels rows, stranded raw-hash messages) on an in-memory SQLite DB and
 * asserts everything collapses onto the canonical CHANNEL_DB_OFFSET + dbId
 * identity — while TCP device slots are left untouched.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './103_consolidate_mqtt_channels.js';

const OFFSET = 100;

function setupSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL);
    CREATE TABLE channel_database (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, psk TEXT NOT NULL, psk_length INTEGER NOT NULL DEFAULT 0,
      description TEXT, is_enabled INTEGER NOT NULL DEFAULT 1,
      enforce_name_validation INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      decrypted_packet_count INTEGER NOT NULL DEFAULT 0, last_decrypted_at INTEGER,
      created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE channel_database_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      channel_database_id INTEGER NOT NULL, can_view_on_map INTEGER NOT NULL DEFAULT 0,
      can_read INTEGER NOT NULL DEFAULT 0, granted_by INTEGER, granted_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channels (
      pk INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, name TEXT,
      sourceId TEXT, role INTEGER DEFAULT 2
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, channel INTEGER NOT NULL DEFAULT 0, sourceId TEXT
    );
  `);
}

function seedDb(db: Database.Database) {
  const now = 1700000000000;
  const cd = db.prepare(
    `INSERT INTO channel_database (id, name, psk, psk_length, description, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Duplicate passive "Primary" rows (race), distinct keyed channels.
  cd.run(1, 'Primary', '', 0, 'passive', 0, now, now);
  cd.run(2, 'Primary', '', 0, 'passive', 0, now, now); // dup of id 1
  cd.run(3, 'LongFast', 'AQ==', 1, 'seeded', 1, now, now);
  cd.run(4, 'MediumFast', 'AQ==', 1, 'seeded', 1, now, now);

  // Permissions: user 7 granted on the dup id 2 → must repoint to id 1.
  db.prepare(
    `INSERT INTO channel_database_permissions (user_id, channel_database_id, can_read, granted_at) VALUES (?, ?, 1, ?)`,
  ).run(7, 2, now);

  db.prepare(`INSERT INTO sources (id, type) VALUES (?, ?)`).run('mqtt1', 'mqtt_bridge');
  db.prepare(`INSERT INTO sources (id, type) VALUES (?, ?)`).run('tcp1', 'meshtastic_tcp');

  const ch = db.prepare(`INSERT INTO channels (id, name, sourceId) VALUES (?, ?, ?)`);
  // MQTT hash-keyed rows: LongFast split across 1/8/40(lowercase), MediumFast on 31.
  ch.run(1, 'LongFast', 'mqtt1');
  ch.run(8, 'LongFast', 'mqtt1');
  ch.run(40, 'Longfast', 'mqtt1'); // case drift — same logical channel
  ch.run(31, 'MediumFast', 'mqtt1');
  // Hash >= OFFSET (channel hashes range 0-255) — must still be deleted.
  ch.run(168, 'MediumFast', 'mqtt1');
  // TCP device slot — MUST be left untouched.
  ch.run(0, 'Primary', 'tcp1');

  const m = db.prepare(`INSERT INTO messages (id, channel, sourceId) VALUES (?, ?, ?)`);
  m.run('m1', OFFSET + 1, 'mqtt1'); // Primary canonical
  m.run('m2', OFFSET + 2, 'mqtt1'); // Primary dup → should become OFFSET+1
  m.run('m3', 8, 'mqtt1');          // stranded raw hash → LongFast (db 3) → 103
  m.run('m4', 1, 'mqtt1');          // stranded raw hash → LongFast (db 3) → 103
  m.run('m5', 31, 'mqtt1');         // stranded raw hash → MediumFast (db 4) → 104
  m.run('m6', 40, 'mqtt1');         // stranded lowercase → LongFast (db 3) → 103
  m.run('m7', 0, 'tcp1');           // TCP slot-0 message — MUST be untouched
  m.run('m8', OFFSET + 4, 'mqtt1'); // already-canonical MediumFast (104) — unchanged
}

describe('migration 103 — consolidate MQTT channels', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    setupSchema(db);
    seedDb(db);
    migration.up(db);
  });

  it('merges duplicate channel_database rows by (lower(name), psk)', () => {
    const primaries = db.prepare(`SELECT id FROM channel_database WHERE lower(name) = 'primary'`).all();
    expect(primaries).toEqual([{ id: 1 }]); // dup id 2 removed
  });

  it('repoints messages off the merged duplicate dbId', () => {
    const ch = (id: string) => (db.prepare(`SELECT channel FROM messages WHERE id = ?`).get(id) as { channel: number }).channel;
    expect(ch('m1')).toBe(OFFSET + 1);
    expect(ch('m2')).toBe(OFFSET + 1); // 102 → 101
  });

  it('repoints channel_database_permissions off the duplicate', () => {
    const perm = db.prepare(`SELECT channel_database_id FROM channel_database_permissions WHERE user_id = 7`).get() as { channel_database_id: number };
    expect(perm.channel_database_id).toBe(1);
  });

  it('deletes all hash-keyed channels rows for the MQTT source (incl. hashes >= OFFSET)', () => {
    const rows = db.prepare(`SELECT id FROM channels WHERE sourceId = 'mqtt1'`).all();
    expect(rows).toEqual([]);
  });

  it('leaves already-canonical messages and ambiguous hash>=OFFSET messages untouched', () => {
    // m8 was already on the canonical 104 and must stay; the hash-168 row is
    // deleted but its (ambiguous) messages, if any, are not blindly repointed.
    const m8 = db.prepare(`SELECT channel FROM messages WHERE id = 'm8'`).get() as { channel: number };
    expect(m8.channel).toBe(OFFSET + 4);
  });

  it('repoints stranded raw-hash messages onto CHANNEL_DB_OFFSET + dbId by name', () => {
    const ch = (id: string) => (db.prepare(`SELECT channel FROM messages WHERE id = ?`).get(id) as { channel: number }).channel;
    expect(ch('m3')).toBe(OFFSET + 3); // raw 8  (LongFast)   → 103
    expect(ch('m4')).toBe(OFFSET + 3); // raw 1  (LongFast)   → 103
    expect(ch('m5')).toBe(OFFSET + 4); // raw 31 (MediumFast) → 104
    expect(ch('m6')).toBe(OFFSET + 3); // raw 40 (Longfast)   → 103 (case-insensitive)
  });

  it('leaves TCP device channels and their messages untouched', () => {
    const slot = db.prepare(`SELECT id, name FROM channels WHERE sourceId = 'tcp1'`).all();
    expect(slot).toEqual([{ id: 0, name: 'Primary' }]);
    const m7 = db.prepare(`SELECT channel FROM messages WHERE id = 'm7'`).get() as { channel: number };
    expect(m7.channel).toBe(0);
  });

  it('is idempotent — a second run changes nothing', () => {
    migration.up(db); // run again
    const cdCount = db.prepare(`SELECT COUNT(*) AS c FROM channel_database`).get() as { c: number };
    const mqttChans = db.prepare(`SELECT COUNT(*) AS c FROM channels WHERE sourceId = 'mqtt1'`).get() as { c: number };
    expect(cdCount.c).toBe(3); // Primary(1), LongFast(3), MediumFast(4)
    expect(mqttChans.c).toBe(0);
  });
});
