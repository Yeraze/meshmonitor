/**
 * Tests for migration 186 — merge default-row mutes into per-source rows (#5487).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration, mergeMuteRules } from './186_merge_default_row_mutes_into_source_rows.js';

const FUTURE = Date.now() + 24 * 60 * 60 * 1000;
const LATER = FUTURE + 60 * 60 * 1000;
const PAST = Date.now() - 1000;

function setup(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE user_notification_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      muted_channels TEXT,
      muted_dms TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO sources (id, name, type) VALUES ('mt', 'TCP', 'meshtastic_tcp'), ('mc', 'MC', 'meshcore');
  `);
  return db;
}

function insert(db: Database.Database, userId: number, sourceId: string, channels: unknown, dms: unknown): void {
  db.prepare(
    'INSERT INTO user_notification_preferences (user_id, source_id, muted_channels, muted_dms, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
  ).run(userId, sourceId, channels === null ? null : JSON.stringify(channels), dms === null ? null : JSON.stringify(dms));
}

function read(db: Database.Database, userId: number, sourceId: string) {
  const row = db.prepare('SELECT muted_channels AS c, muted_dms AS d FROM user_notification_preferences WHERE user_id = ? AND source_id = ?')
    .get(userId, sourceId) as { c: string | null; d: string | null } | undefined;
  if (!row) return undefined;
  return { channels: row.c ? JSON.parse(row.c) : null, dms: row.d ? JSON.parse(row.d) : null };
}

describe('mergeMuteRules', () => {
  it('unions by key, keeps the later muteUntil, and treats null as indefinite', () => {
    const now = Date.now();
    const merged = mergeMuteRules(
      [{ channelId: 1, muteUntil: FUTURE }, { channelId: 2, muteUntil: null }],
      [{ channelId: 1, muteUntil: LATER }, { channelId: 2, muteUntil: LATER }, { channelId: 3, muteUntil: null }],
      'channelId',
      now,
    );
    expect(merged).toEqual([
      { channelId: 1, muteUntil: LATER },
      { channelId: 2, muteUntil: null },
      { channelId: 3, muteUntil: null },
    ]);
  });

  it('skips expired incoming rules and returns null when nothing changes', () => {
    const now = Date.now();
    expect(mergeMuteRules([{ channelId: 1, muteUntil: null }], [{ channelId: 4, muteUntil: PAST }], 'channelId', now)).toBeNull();
    expect(mergeMuteRules([{ channelId: 1, muteUntil: LATER }], [{ channelId: 1, muteUntil: FUTURE }], 'channelId', now)).toBeNull();
  });
});

describe('Migration 186 — SQLite', () => {
  it('merges channel and DM mutes separately into existing Meshtastic per-source rows', () => {
    const db = setup();
    insert(db, 1, '', [{ channelId: 2, muteUntil: null }, { channelId: 5, muteUntil: PAST }], [{ nodeUuid: '!aaaa', muteUntil: FUTURE }]);
    insert(db, 1, 'mt', [{ channelId: 3, muteUntil: FUTURE }], [{ nodeUuid: '!bbbb', muteUntil: null }]);

    migration.up(db);

    const mt = read(db, 1, 'mt')!;
    expect(mt.channels).toEqual([{ channelId: 3, muteUntil: FUTURE }, { channelId: 2, muteUntil: null }]);
    expect(mt.dms).toEqual([{ nodeUuid: '!bbbb', muteUntil: null }, { nodeUuid: '!aaaa', muteUntil: FUTURE }]);
    // The '' row is left as-is (still the fallback for row-less sources).
    expect(read(db, 1, '')!.channels).toHaveLength(2);
    db.close();
  });

  it('keeps a DM list untouched when only the channel list changes', () => {
    const db = setup();
    insert(db, 1, '', [{ channelId: 2, muteUntil: null }], []);
    insert(db, 1, 'mt', [], [{ nodeUuid: '!bbbb', muteUntil: null }]);
    migration.up(db);
    expect(read(db, 1, 'mt')).toEqual({
      channels: [{ channelId: 2, muteUntil: null }],
      dms: [{ nodeUuid: '!bbbb', muteUntil: null }],
    });
    db.close();
  });

  it('skips MeshCore rows, creates no rows, and never crosses users', () => {
    const db = setup();
    insert(db, 1, '', [{ channelId: 2, muteUntil: null }], []);
    insert(db, 1, 'mc', [{ channelId: 7, muteUntil: null }], []);
    insert(db, 2, 'mt', null, null);
    migration.up(db);
    expect(read(db, 1, 'mc')!.channels).toEqual([{ channelId: 7, muteUntil: null }]);
    expect(read(db, 1, 'mt')).toBeUndefined();
    expect(read(db, 2, 'mt')).toEqual({ channels: null, dms: null });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM user_notification_preferences').get() as { n: number }).n;
    expect(count).toBe(3);
    db.close();
  });

  it('is idempotent', () => {
    const db = setup();
    insert(db, 1, '', [{ channelId: 2, muteUntil: FUTURE }], [{ nodeUuid: '!aaaa', muteUntil: null }]);
    insert(db, 1, 'mt', null, null);
    migration.up(db);
    const first = read(db, 1, 'mt');
    migration.up(db);
    expect(read(db, 1, 'mt')).toEqual(first);
    expect(first).toEqual({
      channels: [{ channelId: 2, muteUntil: FUTURE }],
      dms: [{ nodeUuid: '!aaaa', muteUntil: null }],
    });
    db.close();
  });

  it('runs on a table with no sources table and no rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE user_notification_preferences (id INTEGER PRIMARY KEY, user_id INTEGER, source_id TEXT, muted_channels TEXT, muted_dms TEXT)`);
    expect(() => migration.up(db)).not.toThrow();
    db.close();
  });
});
