/**
 * Migration 225: per-source, protocol-aware device-config backups (#6285 P8b).
 *
 *   backup_history.sourceId  TEXT NULL     owning source (NULL = legacy / unowned)
 *   backup_history.protocol  TEXT NOT NULL DEFAULT 'meshtastic'
 *   index idx_backup_history_source_ts (sourceId, timestamp)
 *
 * Backfill: legacy rows go to the only Meshtastic TCP source when there is
 * exactly one; otherwise they stay NULL (admin-only).
 *
 * Seed: the global schedule settings (backup_enabled, backup_time,
 * backup_maxBackups, backup_lastAutomaticBackup) become per-source keys
 * `source:<id>:<key>` for the primary Meshtastic TCP source only. Existing
 * per-source keys are never overwritten. The globals stay in place (unread).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 225';
const TABLE = 'backup_history';
const INDEX = 'idx_backup_history_source_ts';

/** Global key -> per-source key suffix. The last-run stamp is converted to a date. */
const SEED_KEYS = ['backup_enabled', 'backup_time', 'backup_maxBackups'] as const;

function lastDate(value: string | null | undefined): string | null {
  if (!value || value.length < 10) return null;
  return value.slice(0, 10);
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding sourceId/protocol to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'sourceId', 'sourceId TEXT');
    addColumnIfMissing(db, TABLE, 'protocol', "protocol TEXT NOT NULL DEFAULT 'meshtastic'");
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (sourceId, timestamp)`);

    const sources = db
      .prepare(`SELECT id FROM sources WHERE type = 'meshtastic_tcp' ORDER BY enabled DESC, displayOrder, createdAt`)
      .all() as Array<{ id: string }>;
    if (sources.length === 1) {
      db.prepare(`UPDATE ${TABLE} SET sourceId = ? WHERE sourceId IS NULL`).run(sources[0].id);
    }
    if (sources.length === 0) return;

    const primary = sources[0].id;
    const now = Date.now();
    const get = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const put = db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
    );
    for (const k of SEED_KEYS) {
      const row = get.get(k) as { value: string } | undefined;
      if (row) put.run(`source:${primary}:${k}`, row.value, now, now);
    }
    const last = lastDate((get.get('backup_lastAutomaticBackup') as { value: string } | undefined)?.value);
    if (last) put.run(`source:${primary}:backup_lastAutomaticBackupDate`, last, now, now);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration225Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding sourceId/protocol to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'sourceId', '"sourceId" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'protocol', `"protocol" TEXT NOT NULL DEFAULT 'meshtastic'`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} ("sourceId", timestamp)`);

  const { rows: sources } = await client.query(
    `SELECT id FROM sources WHERE type = 'meshtastic_tcp' ORDER BY enabled DESC, "displayOrder", "createdAt"`,
  );
  if (sources.length === 1) {
    await client.query(`UPDATE ${TABLE} SET "sourceId" = $1 WHERE "sourceId" IS NULL`, [sources[0].id]);
  }
  if (sources.length === 0) return;

  const primary = sources[0].id as string;
  const now = Date.now();
  const put = (key: string, value: string) =>
    client.query(
      `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING`,
      [key, value, now, now],
    );
  for (const k of SEED_KEYS) {
    const r = await client.query(`SELECT value FROM settings WHERE key = $1`, [k]);
    if (r.rows.length) await put(`source:${primary}:${k}`, r.rows[0].value);
  }
  const l = await client.query(`SELECT value FROM settings WHERE key = $1`, ['backup_lastAutomaticBackup']);
  const last = lastDate(l.rows[0]?.value);
  if (last) await put(`source:${primary}:backup_lastAutomaticBackupDate`, last);
}

// ============ MySQL ============

export async function runMigration225Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding sourceId/protocol to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'sourceId', 'sourceId VARCHAR(36)');
  await addColumnIfMissingMysql(pool, TABLE, 'protocol', "protocol VARCHAR(16) NOT NULL DEFAULT 'meshtastic'");
  await createIndexIfMissingMysql(pool, TABLE, INDEX, `CREATE INDEX ${INDEX} ON ${TABLE} (sourceId, timestamp)`);

  const [srcRows] = await pool.query(
    `SELECT id FROM sources WHERE type = 'meshtastic_tcp' ORDER BY enabled DESC, displayOrder, createdAt`,
  );
  const sources = srcRows as Array<{ id: string }>;
  if (sources.length === 1) {
    await pool.query(`UPDATE ${TABLE} SET sourceId = ? WHERE sourceId IS NULL`, [sources[0].id]);
  }
  if (sources.length === 0) return;

  const primary = sources[0].id;
  const now = Date.now();
  const put = (key: string, value: string) =>
    pool.query(
      'INSERT IGNORE INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
      [key, value, now, now],
    );
  const read = async (key: string): Promise<string | undefined> => {
    const [r] = await pool.query('SELECT value FROM settings WHERE `key` = ?', [key]);
    return (r as Array<{ value: string }>)[0]?.value;
  };
  for (const k of SEED_KEYS) {
    const v = await read(k);
    if (v !== undefined) await put(`source:${primary}:${k}`, v);
  }
  const last = lastDate(await read('backup_lastAutomaticBackup'));
  if (last) await put(`source:${primary}:backup_lastAutomaticBackupDate`, last);
}
