/**
 * Migration 117: Drop the retired `upgrade_history` table and delete the
 * `autoUpgrade*` settings rows (Auto-Upgrade Retirement, v4.13).
 *
 * In-app upgrade execution (watchdog sidecar, trigger/status files, circuit
 * breaker) was removed in v4.13. The reconciliation state it kept in
 * `upgrade_history` is dead; the human-readable history lives in `audit_log`,
 * so dropping the table loses nothing users see.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 117';
const TABLE = 'upgrade_history';
const SETTINGS_KEYS = ['autoUpgradeImmediate', 'autoUpgradeBlocked', 'autoUpgradeBlockedReason'];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): dropping ${TABLE} and autoUpgrade* settings...`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
    for (const key of SETTINGS_KEYS) {
      stmt.run(key);
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    // No-op: the table is retired and not recreated on downgrade.
    logger.info(`${LABEL} down (SQLite): no-op (upgrade_history is retired)`);
    void db;
  },
};

// ============ PostgreSQL ============

export async function runMigration117Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): dropping ${TABLE} and autoUpgrade* settings...`);
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
  // PostgreSQL settings table uses a quoted camelCase "key" column.
  await client.query('DELETE FROM settings WHERE "key" = ANY($1)', [SETTINGS_KEYS]);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration117Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): dropping ${TABLE} and autoUpgrade* settings...`);
  const conn = await pool.getConnection();
  try {
    await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await conn.query('DELETE FROM settings WHERE `key` IN (?, ?, ?)', SETTINGS_KEYS);
  } finally {
    conn.release();
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
