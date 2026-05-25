/**
 * Migration 071: Drop the legacy `CHECK (psk_length IN (16, 32))` constraint
 * from `channel_database` on SQLite installs that pre-date the v3.7 baseline.
 *
 * The old constraint rejects `pskLength = 1`, which is what the MQTT
 * default-channel bootstrap inserts for the shorthand `AQ==` key
 * (`expandShorthandPsk` expands it to the full 16-byte default key at
 * decryption time). On affected databases every MQTT source start logs:
 *
 *   MQTT source <uuid> channel_database bootstrap failed:
 *     CHECK constraint failed: psk_length IN (16, 32)
 *
 * and the channel row is never inserted, so MeshMonitor cannot decrypt
 * default-key MQTT traffic. The constraint was removed from the v3.7 baseline
 * (migration 001), but `CREATE TABLE IF NOT EXISTS` leaves the existing
 * pre-v3.7 table — constraint and all — untouched.
 *
 * This migration:
 *   - SQLite: detects the legacy CHECK by inspecting `sqlite_master.sql`,
 *     and if present rebuilds the table without it (preserves rows + ids).
 *   - PostgreSQL / MySQL: no-op. The constraint only ever lived in SQLite.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 071';
const TABLE = 'channel_database';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(TABLE) as { sql?: string } | undefined;
    const sql = row?.sql ?? '';

    // Match either `psk_length IN (16, 32)` or any explicit CHECK referencing
    // psk_length — we want to strip the legacy AES-128/256-only constraint
    // regardless of whitespace variation.
    const hasLegacyCheck = /CHECK\s*\([^)]*psk_length[^)]*\)/i.test(sql);
    if (!hasLegacyCheck) {
      logger.debug(`${LABEL} (SQLite): no legacy psk_length CHECK on ${TABLE}, skipping`);
      return;
    }

    logger.info(`${LABEL} (SQLite): rebuilding ${TABLE} to drop legacy psk_length CHECK constraint`);

    // SQLite cannot drop a CHECK constraint in place. The standard
    // workaround is the table-rebuild dance from the migration 006 pattern:
    // create a new table with the desired schema, copy rows, drop the old
    // table, rename, recreate indexes. FK enforcement is toggled off so
    // dropping the table doesn't trip references from
    // channel_database_permissions, then re-enabled.
    const fkOn = (db.pragma('foreign_keys', { simple: true }) as 0 | 1) === 1;
    if (fkOn) db.pragma('foreign_keys = OFF');

    try {
      db.exec(`
        CREATE TABLE channel_database_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          psk TEXT NOT NULL,
          psk_length INTEGER NOT NULL,
          description TEXT,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          enforce_name_validation INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
          last_decrypted_at INTEGER,
          created_by INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      // Some pre-v3.7 schemas may be missing `enforce_name_validation` or
      // `sort_order` (added by later deleted migrations whose work is now
      // folded into the baseline CREATE TABLE). Build the column list from
      // the legacy table's actual columns so the copy works against any
      // historical shape.
      const legacyCols = (
        db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      const newCols = [
        'id',
        'name',
        'psk',
        'psk_length',
        'description',
        'is_enabled',
        'enforce_name_validation',
        'sort_order',
        'decrypted_packet_count',
        'last_decrypted_at',
        'created_by',
        'created_at',
        'updated_at',
      ];
      const shared = newCols.filter((c) => legacyCols.includes(c));
      const colList = shared.join(', ');
      db.exec(`INSERT INTO channel_database_new (${colList}) SELECT ${colList} FROM ${TABLE}`);

      db.exec(`DROP TABLE ${TABLE}`);
      db.exec(`ALTER TABLE channel_database_new RENAME TO ${TABLE}`);

      // Recreate index from baseline (only one defined on this table).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_database_enabled ON ${TABLE}(is_enabled)`);

      logger.debug(`${LABEL} (SQLite): rebuild complete`);
    } finally {
      if (fkOn) db.pragma('foreign_keys = ON');
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (re-adding the legacy CHECK would re-break MQTT bootstrap)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration071Postgres(_client: any): Promise<void> {
  logger.debug(`${LABEL} (PostgreSQL): no-op (psk_length CHECK constraint never existed in PG schema)`);
}

// ============ MySQL ============

export async function runMigration071Mysql(_pool: any): Promise<void> {
  logger.debug(`${LABEL} (MySQL): no-op (psk_length CHECK constraint never existed in MySQL schema)`);
}
