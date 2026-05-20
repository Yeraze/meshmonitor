/**
 * Migration 065 — Add source_ip + source_path columns to messages table.
 * SQLite-only unit test; Postgres / MySQL paths share the same shape and are
 * exercised by the integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './065_add_message_source_attribution.js';

function createMessagesTable(db: Database.Database) {
  // Minimal pre-migration messages table — only the columns required to
  // exercise the ALTER TABLE.
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      fromNodeNum INTEGER NOT NULL,
      toNodeNum INTEGER NOT NULL,
      fromNodeId TEXT NOT NULL,
      toNodeId TEXT NOT NULL,
      text TEXT NOT NULL,
      channel INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name);
}

describe('migration 065: add source_ip + source_path columns', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createMessagesTable(db);
  });

  it('adds source_ip and source_path columns to messages', () => {
    expect(columnNames(db, 'messages')).not.toContain('source_ip');
    expect(columnNames(db, 'messages')).not.toContain('source_path');

    migration.up(db);

    const cols = columnNames(db, 'messages');
    expect(cols).toContain('source_ip');
    expect(cols).toContain('source_path');
  });

  it('is idempotent — running twice is a no-op', () => {
    migration.up(db);
    migration.up(db); // should not throw on duplicate column
    const cols = columnNames(db, 'messages');
    expect(cols.filter((c) => c === 'source_ip')).toHaveLength(1);
    expect(cols.filter((c) => c === 'source_path')).toHaveLength(1);
  });

  it('leaves existing rows with NULL for both columns (backward compatible)', () => {
    const ts = Date.now();
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, timestamp, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('msg-1', 1, 2, '!00000001', '!00000002', 'hello', ts, ts);

    migration.up(db);

    const row = db.prepare(`SELECT source_ip, source_path FROM messages WHERE id = ?`).get('msg-1') as any;
    expect(row.source_ip).toBeNull();
    expect(row.source_path).toBeNull();
  });

  it('accepts new rows with populated source_ip and source_path', () => {
    migration.up(db);

    const ts = Date.now();
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, timestamp, createdAt, source_ip, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('msg-2', 1, 2, '!00000001', '!00000002', 'world', ts, ts, '192.0.2.42', 'http_api');

    const row = db.prepare(`SELECT source_ip, source_path FROM messages WHERE id = ?`).get('msg-2') as any;
    expect(row.source_ip).toBe('192.0.2.42');
    expect(row.source_path).toBe('http_api');
  });
});
