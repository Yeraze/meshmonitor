/**
 * Migration 123 — Re-file MQTT directed messages into the DM view (SQLite path).
 *
 * Verifies the one-shot cleanup sets `channel = -1` for MQTT-sourced directed
 * TEXT_MESSAGE_APP rows only, leaves broadcasts / non-text / TCP rows untouched,
 * and is idempotent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './123_fix_mqtt_directed_message_channel.js';

const BROADCAST = 4294967295;

function createMessagesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      portnum INTEGER,
      viaMqtt INTEGER,
      text TEXT
    );
  `);
}

interface Row { id: string; toNodeNum: number; channel: number; portnum: number | null; viaMqtt: number | null; }

function insert(db: Database.Database, r: Row) {
  db.prepare(
    'INSERT INTO messages (id, fromNodeNum, toNodeNum, channel, portnum, viaMqtt, text) VALUES (?, 1, ?, ?, ?, ?, ?)',
  ).run(r.id, r.toNodeNum, r.channel, r.portnum, r.viaMqtt, 'hi');
}

function channelOf(db: Database.Database, id: string): number {
  return (db.prepare('SELECT channel FROM messages WHERE id = ?').get(id) as { channel: number }).channel;
}

describe('Migration 123: re-file MQTT directed messages (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createMessagesTable(db);
    insert(db, { id: 'mqtt-dm',        toNodeNum: 0x11223344, channel: 8,  portnum: 1, viaMqtt: 1 }); // → -1
    insert(db, { id: 'mqtt-broadcast', toNodeNum: BROADCAST,  channel: 8,  portnum: 1, viaMqtt: 1 }); // untouched
    insert(db, { id: 'mqtt-dm-nontext',toNodeNum: 0x11223344, channel: 8,  portnum: 3, viaMqtt: 1 }); // untouched (not TEXT)
    insert(db, { id: 'tcp-dm',         toNodeNum: 0x11223344, channel: 8,  portnum: 1, viaMqtt: 0 }); // untouched (not MQTT)
    insert(db, { id: 'mqtt-dm-already',toNodeNum: 0x11223344, channel: -1, portnum: 1, viaMqtt: 1 }); // already correct
  });

  it('sets channel -1 only for MQTT-sourced directed TEXT messages', () => {
    migration.up(db);
    expect(channelOf(db, 'mqtt-dm')).toBe(-1);
  });

  it('leaves broadcasts, non-text, and TCP rows untouched', () => {
    migration.up(db);
    expect(channelOf(db, 'mqtt-broadcast')).toBe(8);
    expect(channelOf(db, 'mqtt-dm-nontext')).toBe(8);
    expect(channelOf(db, 'tcp-dm')).toBe(8);
  });

  it('is idempotent (re-run changes nothing, already-(-1) rows stay)', () => {
    migration.up(db);
    expect(channelOf(db, 'mqtt-dm-already')).toBe(-1);
    // Second run must be a no-op — the `channel <> -1` predicate matches nothing.
    migration.up(db);
    expect(channelOf(db, 'mqtt-dm')).toBe(-1);
    expect(channelOf(db, 'mqtt-broadcast')).toBe(8);
  });
});
