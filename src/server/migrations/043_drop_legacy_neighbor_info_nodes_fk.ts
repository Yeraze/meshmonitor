/**
 * Migration 043: Drop legacy `neighbor_info.nodeNum`/`neighborNodeNum`
 * REFERENCES `nodes(nodeNum)` FKs.
 *
 * Context:
 *   Legacy SQLite databases created by pre-baseline Drizzle pushes carry
 *   foreign key declarations on `neighbor_info.nodeNum` and
 *   `neighbor_info.neighborNodeNum` pointing at `nodes(nodeNum)`.
 *   Migration 029 rebuilt `nodes` with a composite PRIMARY KEY
 *   (nodeNum, sourceId), which makes those FKs structurally invalid — any
 *   DML on `neighbor_info` with foreign_keys=ON raises:
 *
 *     SqliteError: foreign key mismatch - "neighbor_info" referencing "nodes"
 *
 *   This was the exact failure surfaced by migration 040 in 4.0-beta8.
 *   Rebuilds the table once without the FKs so future migrations don't need
 *   to toggle foreign_keys=OFF on every call site.
 *
 *   The v3.7 baseline never declared these FKs, so the rebuild is a no-op on
 *   non-legacy databases (idempotency check skips out when no FK is present).
 *
 * Dialect notes:
 *   - SQLite: legacy FKs exist only here; rebuild.
 *   - PostgreSQL / MySQL: never had these FKs. No-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const NEIGHBOR_INFO_COLUMNS_SQLITE = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nodeNum INTEGER NOT NULL,
  neighborNodeNum INTEGER NOT NULL,
  snr REAL,
  lastRxTime INTEGER,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  sourceId TEXT
`;

const NEIGHBOR_INFO_EXPECTED_COLUMNS = [
  'id', 'nodeNum', 'neighborNodeNum', 'snr', 'lastRxTime', 'timestamp',
  'createdAt', 'sourceId',
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const fkRows = db.prepare(`PRAGMA foreign_key_list(neighbor_info)`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;

    const legacyFk = fkRows.find(
      (r) => String(r.table).toLowerCase() === 'nodes',
    );
    if (!legacyFk) {
      logger.debug('Migration 043 (SQLite): no legacy neighbor_info→nodes FK present, skipping');
      return;
    }

    logger.info('Migration 043 (SQLite): rebuilding neighbor_info to drop legacy FK to nodes(nodeNum)...');

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const liveCols = new Set(
      (db.prepare(`PRAGMA table_info(neighbor_info)`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const copyCols = NEIGHBOR_INFO_EXPECTED_COLUMNS.filter((c) => liveCols.has(c));
    const copyList = copyCols.join(', ');

    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'neighbor_info' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE neighbor_info_new (${NEIGHBOR_INFO_COLUMNS_SQLITE})`);
      db.exec(`
        INSERT INTO neighbor_info_new (${copyList})
        SELECT ${copyList} FROM neighbor_info
      `);
      db.exec(`DROP TABLE neighbor_info`);
      db.exec(`ALTER TABLE neighbor_info_new RENAME TO neighbor_info`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 043 (SQLite): failed to recreate index ${idx.name}:`, err);
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

    logger.info('Migration 043 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 043 down: not implemented (re-adding the broken FK is undesirable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration043Postgres(_client: any): Promise<void> {
  logger.debug('Migration 043 (PostgreSQL): no-op (no legacy neighbor_info FK on PG)');
}

// ============ MySQL ============

export async function runMigration043Mysql(_pool: any): Promise<void> {
  logger.debug('Migration 043 (MySQL): no-op (no legacy neighbor_info FK on MySQL)');
}
