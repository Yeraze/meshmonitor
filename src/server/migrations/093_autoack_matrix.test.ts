import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { computeMatrixValues, computeMigrationInserts, migration } from './093_autoack_matrix.js';

// Mirrors src/db/schema/settings.ts — createdAt/updatedAt are NOT NULL with no
// DB default, which is exactly what the migration insert must satisfy.
function makeSettingsDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`);
  return db;
}

describe('093 auto-ack matrix migration — computeMatrixValues', () => {
  it('uses legacy defaults (behavior ON, DM gates OFF) when nothing is set', () => {
    const v = computeMatrixValues({});
    // Channel column on (behavior defaulted ON); DM routing off.
    expect(v.autoAckChannelZeroHopReplyEnabled).toBe('true');
    expect(v.autoAckChannelZeroHopTapbackEnabled).toBe('true');
    expect(v.autoAckChannelZeroHopReplyDmEnabled).toBe('false');
    expect(v.autoAckChannelMultiHopReplyEnabled).toBe('true');
    expect(v.autoAckChannelMultiHopTapbackEnabled).toBe('true');
    // Direct column off (DMs were disabled by default).
    expect(v.autoAckDirectZeroHopReplyEnabled).toBe('false');
    expect(v.autoAckDirectZeroHopTapbackEnabled).toBe('false');
    expect(v.autoAckDirectMultiHopReplyEnabled).toBe('false');
    // Direct replies are inherently DMs.
    expect(v.autoAckDirectZeroHopReplyDmEnabled).toBe('true');
    expect(v.autoAckDirectMultiHopReplyDmEnabled).toBe('true');
  });

  it('enables the Direct column when DMs were enabled', () => {
    const v = computeMatrixValues({ autoAckDirectMessages: 'true' });
    expect(v.autoAckDirectZeroHopReplyEnabled).toBe('true');
    expect(v.autoAckDirectZeroHopTapbackEnabled).toBe('true');
    expect(v.autoAckDirectMultiHopReplyEnabled).toBe('true');
    expect(v.autoAckDirectMultiHopTapbackEnabled).toBe('true');
  });

  it('maps global useDM to the Channel cells Respond-via-DM toggle', () => {
    const v = computeMatrixValues({ autoAckUseDM: 'true' });
    expect(v.autoAckChannelZeroHopReplyDmEnabled).toBe('true');
    expect(v.autoAckChannelMultiHopReplyDmEnabled).toBe('true');
  });

  it('respects a disabled multihop section', () => {
    const v = computeMatrixValues({ autoAckMultihopEnabled: 'false', autoAckDirectMessages: 'true' });
    expect(v.autoAckChannelMultiHopReplyEnabled).toBe('false');
    expect(v.autoAckChannelMultiHopTapbackEnabled).toBe('false');
    expect(v.autoAckDirectMultiHopReplyEnabled).toBe('false');
    // Zero-hop unaffected.
    expect(v.autoAckChannelZeroHopReplyEnabled).toBe('true');
  });

  it('respects a disabled per-action toggle within a section', () => {
    const v = computeMatrixValues({ autoAckDirectReplyEnabled: 'false' });
    expect(v.autoAckChannelZeroHopReplyEnabled).toBe('false');
    expect(v.autoAckChannelZeroHopTapbackEnabled).toBe('true'); // tapback still on
  });

  it('an entirely disabled section zeroes both reply and tapback', () => {
    const v = computeMatrixValues({ autoAckDirectEnabled: 'false', autoAckDirectMessages: 'true' });
    expect(v.autoAckChannelZeroHopReplyEnabled).toBe('false');
    expect(v.autoAckChannelZeroHopTapbackEnabled).toBe('false');
    expect(v.autoAckDirectZeroHopReplyEnabled).toBe('false');
  });
});

describe('093 auto-ack matrix migration — computeMigrationInserts', () => {
  it('migrates a global config and prefixes keys with nothing', () => {
    const rows = computeMigrationInserts([
      { key: 'autoAckEnabled', value: 'true' },
      { key: 'autoAckDirectMessages', value: 'true' },
    ]);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('autoAckChannelZeroHopReplyEnabled');
    expect(keys).toContain('autoAckDirectMultiHopReplyEnabled');
    expect(keys).toHaveLength(12);
    expect(rows.find((r) => r.key === 'autoAckDirectZeroHopReplyEnabled')?.value).toBe('true');
  });

  it('migrates per-source configs under their source:<id>: prefix', () => {
    const rows = computeMigrationInserts([
      { key: 'source:abc-123:autoAckEnabled', value: 'true' },
      { key: 'source:abc-123:autoAckUseDM', value: 'true' },
    ]);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.key.startsWith('source:abc-123:'))).toBe(true);
    expect(rows.find((r) => r.key === 'source:abc-123:autoAckChannelZeroHopReplyDmEnabled')?.value).toBe('true');
  });

  it('handles multiple prefixes independently', () => {
    const rows = computeMigrationInserts([
      { key: 'autoAckEnabled', value: 'true' },
      { key: 'source:s1:autoAckDirectEnabled', value: 'false' },
    ]);
    const global = rows.filter((r) => !r.key.startsWith('source:'));
    const s1 = rows.filter((r) => r.key.startsWith('source:s1:'));
    expect(global).toHaveLength(12);
    expect(s1).toHaveLength(12);
    expect(s1.find((r) => r.key === 'source:s1:autoAckChannelZeroHopReplyEnabled')?.value).toBe('false');
  });

  it('skips prefixes that never used auto-ack (no enable, no behavior keys)', () => {
    // autoAckRegex / autoAckChannels are not behavior keys → not a trigger on their own.
    const rows = computeMigrationInserts([
      { key: 'autoAckRegex', value: '^hi' },
      { key: 'source:s2:autoAckEnabled', value: 'false' },
    ]);
    expect(rows).toHaveLength(0);
  });

  it('migrates an enabled source even when no behavior toggle was customized', () => {
    const rows = computeMigrationInserts([{ key: 'source:s3:autoAckEnabled', value: 'true' }]);
    expect(rows).toHaveLength(12);
    // Defaults: channel cells active, direct cells off.
    expect(rows.find((r) => r.key === 'source:s3:autoAckChannelZeroHopReplyEnabled')?.value).toBe('true');
    expect(rows.find((r) => r.key === 'source:s3:autoAckDirectZeroHopReplyEnabled')?.value).toBe('false');
  });
});

describe('093 SQLite migration — runs against a real settings table', () => {
  it('inserts the 12 matrix rows with non-null createdAt/updatedAt', () => {
    const db = makeSettingsDb();
    const now = 1_700_000_000_000;
    db.prepare('INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?,?,?,?)')
      .run('autoAckEnabled', 'true', now, now);
    db.prepare('INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?,?,?,?)')
      .run('autoAckDirectMessages', 'true', now, now);

    // Must not throw (the bug was a NOT NULL violation on createdAt/updatedAt).
    expect(() => migration.up(db as any)).not.toThrow();

    const matrixRows = db.prepare(
      "SELECT key, value, createdAt, updatedAt FROM settings WHERE key LIKE 'autoAck%Hop%Enabled'",
    ).all() as Array<{ key: string; value: string; createdAt: number; updatedAt: number }>;
    expect(matrixRows).toHaveLength(12);
    for (const row of matrixRows) {
      expect(row.createdAt).not.toBeNull();
      expect(typeof row.createdAt).toBe('number');
      expect(typeof row.updatedAt).toBe('number');
    }
    // DM column enabled because autoAckDirectMessages was true.
    expect(matrixRows.find((r) => r.key === 'autoAckDirectZeroHopReplyEnabled')?.value).toBe('true');
    db.close();
  });

  it('is idempotent — a second run does not throw or duplicate', () => {
    const db = makeSettingsDb();
    const now = 1_700_000_000_000;
    db.prepare('INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?,?,?,?)')
      .run('autoAckEnabled', 'true', now, now);
    migration.up(db as any);
    expect(() => migration.up(db as any)).not.toThrow();
    const count = (db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'autoAck%Hop%Enabled'").get() as { c: number }).c;
    expect(count).toBe(12);
    db.close();
  });

  it('writes nothing when there is no legacy auto-ack config', () => {
    const db = makeSettingsDb();
    migration.up(db as any);
    const count = (db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });
});
