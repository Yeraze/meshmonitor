/**
 * migration 226 (#6285) on SQLite: columns, backfill rule, per-source schedule
 * seed, idempotence. PG/MySQL live in the `.pgmysql.test.ts` sibling.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './226_backup_history_source_protocol.js';

function fixture(sourceRows: Array<{ id: string; type: string; enabled?: number; order?: number; created?: number }>) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE backup_history (id INTEGER PRIMARY KEY AUTOINCREMENT, nodeId TEXT, nodeNum INTEGER, filename TEXT NOT NULL, filePath TEXT NOT NULL, fileSize INTEGER, backupType TEXT NOT NULL, timestamp INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL, config TEXT, enabled INTEGER NOT NULL DEFAULT 1, displayOrder INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
  `);
  for (const s of sourceRows) {
    db.prepare(`INSERT INTO sources (id, name, type, config, enabled, displayOrder, createdAt, updatedAt) VALUES (?, ?, ?, '{}', ?, ?, ?, 0)`)
      .run(s.id, s.id, s.type, s.enabled ?? 1, s.order ?? 0, s.created ?? 1);
  }
  db.prepare(`INSERT INTO backup_history (filename, filePath, backupType, timestamp, createdAt) VALUES ('old.yaml', '/x/old.yaml', 'manual', 1, 1)`).run();
  return db;
}
const setting = (db: Database.Database, key: string) =>
  (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
const setGlobals = (db: Database.Database) => {
  const ins = db.prepare(`INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, 1, 1)`);
  ins.run('backup_enabled', 'true');
  ins.run('backup_time', '04:30');
  ins.run('backup_maxBackups', '12');
  ins.run('backup_lastAutomaticBackup', '2026-11-08T02:00:00.000Z');
};

describe('migration 226 — SQLite', () => {
  it('adds columns + index; legacy rows default to meshtastic', () => {
    const db = fixture([]);
    migration.up(db);
    const cols = (db.prepare(`PRAGMA table_info(backup_history)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['sourceId', 'protocol']));
    const row = db.prepare(`SELECT sourceId, protocol FROM backup_history`).get() as { sourceId: string | null; protocol: string };
    expect(row).toEqual({ sourceId: null, protocol: 'meshtastic' });
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_backup_history_source_ts'`).get();
    expect(idx).toBeTruthy();
  });

  it('exactly one meshtastic_tcp source: backfills legacy rows', () => {
    const db = fixture([{ id: 'a', type: 'meshtastic_tcp' }, { id: 'mc', type: 'meshcore' }]);
    migration.up(db);
    expect((db.prepare(`SELECT sourceId FROM backup_history`).get() as { sourceId: string }).sourceId).toBe('a');
  });

  it('two meshtastic_tcp sources: rows stay NULL (admin-only)', () => {
    const db = fixture([{ id: 'a', type: 'meshtastic_tcp' }, { id: 'b', type: 'meshtastic_tcp' }]);
    migration.up(db);
    expect((db.prepare(`SELECT sourceId FROM backup_history`).get() as { sourceId: string | null }).sourceId).toBeNull();
  });

  it('zero sources: no backfill and no seed', () => {
    const db = fixture([]);
    setGlobals(db);
    migration.up(db);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'source:%'`).get()).toEqual({ c: 0 });
  });

  it('seeds the primary source schedule from the globals only', () => {
    const db = fixture([
      { id: 'late', type: 'meshtastic_tcp', enabled: 1, order: 5 },
      { id: 'first', type: 'meshtastic_tcp', enabled: 1, order: 1 },
      { id: 'off', type: 'meshtastic_tcp', enabled: 0, order: 0 },
      { id: 'mc', type: 'meshcore', order: 0 },
    ]);
    setGlobals(db);
    migration.up(db);
    expect(setting(db, 'source:first:backup_enabled')).toBe('true');
    expect(setting(db, 'source:first:backup_time')).toBe('04:30');
    expect(setting(db, 'source:first:backup_maxBackups')).toBe('12');
    expect(setting(db, 'source:first:backup_lastAutomaticBackupDate')).toBe('2026-11-08');
    expect(setting(db, 'source:late:backup_enabled')).toBeUndefined();
    expect(setting(db, 'source:mc:backup_enabled')).toBeUndefined();
    expect(setting(db, 'backup_enabled')).toBe('true'); // globals left in place
  });

  it('is idempotent and never clobbers an existing per-source key', () => {
    const db = fixture([{ id: 'a', type: 'meshtastic_tcp' }]);
    setGlobals(db);
    db.prepare(`INSERT INTO settings (key, value, createdAt, updatedAt) VALUES ('source:a:backup_time', '09:00', 1, 1)`).run();
    migration.up(db);
    migration.up(db);
    expect(setting(db, 'source:a:backup_time')).toBe('09:00');
    expect(setting(db, 'source:a:backup_maxBackups')).toBe('12');
  });
});
