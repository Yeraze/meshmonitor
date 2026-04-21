/**
 * Migration 041: Drop legacy `telemetry.nodeNum REFERENCES nodes(nodeNum)` FK
 *
 * Context:
 *   Legacy SQLite databases created by pre-baseline Drizzle pushes carry a
 *   foreign key declaration `telemetry.nodeNum REFERENCES nodes(nodeNum)`.
 *   Migration 029 rebuilt `nodes` with a composite PRIMARY KEY
 *   (nodeNum, sourceId), which makes that FK structurally invalid — nodeNum
 *   alone is no longer unique in the parent, so SQLite raises
 *
 *     SqliteError: foreign key mismatch - "telemetry" referencing "nodes"
 *
 *   on any DELETE/INSERT/ALTER on `telemetry` while foreign_keys=ON. PRs
 *   #2740 (029/030) and this migration's sibling commits (032/039) paper
 *   over individual call sites by toggling foreign_keys=OFF for their DML,
 *   but every future migration that touches `telemetry` would need the same
 *   dance. This migration removes the FK permanently by rebuilding the
 *   `telemetry` table without it, aligned to the baseline (v3.7+) schema.
 *
 *   The baseline schema for fresh installs never declared this FK, so the
 *   rebuild is a no-op on non-legacy databases (idempotency check skips out
 *   when no FK is present).
 *
 * Dialect notes:
 *   - SQLite: legacy FK exists only here; rebuild.
 *   - PostgreSQL / MySQL: never had this FK (baseline schema for those
 *     backends created `telemetry` without any FK). No-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// Columns expected on the rebuilt telemetry table, in stable order. Must match
// the post-021 SQLite schema (baseline + sourceId from migration 021).
const TELEMETRY_COLUMNS_SQLITE = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nodeId TEXT NOT NULL,
  nodeNum INTEGER NOT NULL,
  telemetryType TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  createdAt INTEGER NOT NULL,
  packetTimestamp INTEGER,
  packetId INTEGER,
  channel INTEGER,
  precisionBits INTEGER,
  gpsAccuracy REAL,
  sourceId TEXT
`;

const TELEMETRY_COLUMN_LIST = `
  id, nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt,
  packetTimestamp, packetId, channel, precisionBits, gpsAccuracy, sourceId
`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    // Idempotency: if telemetry has no FK, skip. pragma foreign_key_list
    // returns one row per FK declared on the table.
    const fkRows = db.prepare(`PRAGMA foreign_key_list(telemetry)`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;

    const legacyFk = fkRows.find(
      (r) => String(r.table).toLowerCase() === 'nodes' && r.from === 'nodeNum',
    );
    if (!legacyFk) {
      logger.debug('Migration 041 (SQLite): no legacy telemetry→nodes FK present, skipping');
      return;
    }

    logger.info('Migration 041 (SQLite): rebuilding telemetry to drop legacy FK to nodes(nodeNum)...');

    // Standard SQLite table-rebuild requires foreign_keys=OFF
    // (https://www.sqlite.org/lang_altertable.html). legacy_alter_table=ON
    // prevents SQLite from validating the (now broken) FK during RENAME.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    // Snapshot existing indexes so we can recreate them on the rebuilt table.
    // We skip SQLite's auto-indexes (they come back automatically with the
    // rebuilt table) and skip anything without SQL text (can't recreate).
    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'telemetry' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE telemetry_new (${TELEMETRY_COLUMNS_SQLITE})`);
      db.exec(`
        INSERT INTO telemetry_new (${TELEMETRY_COLUMN_LIST})
        SELECT ${TELEMETRY_COLUMN_LIST} FROM telemetry
      `);
      db.exec(`DROP TABLE telemetry`);
      db.exec(`ALTER TABLE telemetry_new RENAME TO telemetry`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 041 (SQLite): failed to recreate index ${idx.name}:`, err);
        }
      }
    });

    try {
      tx();
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
      if (!prevLegacyAlter) {
        db.pragma('legacy_alter_table = OFF');
      }
    }

    logger.info('Migration 041 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 041 down: not implemented (re-adding the broken FK is undesirable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration041Postgres(_client: any): Promise<void> {
  // PostgreSQL baseline never declared this FK. No-op.
  logger.debug('Migration 041 (PostgreSQL): no-op (no legacy telemetry FK on PG)');
}

// ============ MySQL ============

export async function runMigration041Mysql(_pool: any): Promise<void> {
  // MySQL baseline never declared this FK. No-op.
  logger.debug('Migration 041 (MySQL): no-op (no legacy telemetry FK on MySQL)');
}
