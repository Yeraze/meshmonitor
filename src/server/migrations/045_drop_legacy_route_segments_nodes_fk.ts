/**
 * Migration 045: Drop legacy `route_segments.fromNodeNum`/`toNodeNum`
 * REFERENCES `nodes(nodeNum)` FKs.
 *
 * Context:
 *   Legacy SQLite databases created by pre-baseline Drizzle pushes carry
 *   foreign key declarations on `route_segments.fromNodeNum` and
 *   `route_segments.toNodeNum` pointing at `nodes(nodeNum)`. Migration 029
 *   rebuilt `nodes` with a composite PRIMARY KEY (nodeNum, sourceId), which
 *   makes those FKs structurally invalid — any DML on `route_segments` with
 *   foreign_keys=ON raises:
 *
 *     SqliteError: foreign key mismatch - "route_segments" referencing "nodes"
 *
 *   This reliably breaks node deletion, auto-delete-by-distance, purge-all,
 *   and the database-maintenance pass that prunes old route_segments rows.
 *   Migration 030 worked around the same issue by toggling foreign_keys=OFF
 *   during its rebuild, but left the underlying broken FK in place.
 *
 *   This migration rebuilds the table once without the FKs — the same
 *   shape used by 041-044 for telemetry/messages/neighbor_info/traceroutes.
 *
 *   The v3.7 baseline never declared these FKs, so the rebuild is a no-op
 *   on non-legacy databases (idempotency check skips out when no FK is
 *   present).
 *
 * Dialect notes:
 *   - SQLite: legacy FKs exist only here; rebuild.
 *   - PostgreSQL / MySQL: never had these FKs. No-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const ROUTE_SEGMENTS_COLUMNS_SQLITE = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  distanceKm REAL NOT NULL,
  isRecordHolder INTEGER DEFAULT 0,
  fromLatitude REAL,
  fromLongitude REAL,
  toLatitude REAL,
  toLongitude REAL,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  sourceId TEXT
`;

const ROUTE_SEGMENTS_EXPECTED_COLUMNS = [
  'id', 'fromNodeNum', 'toNodeNum', 'fromNodeId', 'toNodeId', 'distanceKm',
  'isRecordHolder', 'fromLatitude', 'fromLongitude', 'toLatitude',
  'toLongitude', 'timestamp', 'createdAt', 'sourceId',
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const fkRows = db.prepare(`PRAGMA foreign_key_list(route_segments)`).all() as Array<{
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
      logger.debug('Migration 045 (SQLite): no legacy route_segments→nodes FK present, skipping');
      return;
    }

    logger.info('Migration 045 (SQLite): rebuilding route_segments to drop legacy FK to nodes(nodeNum)...');

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const liveCols = new Set(
      (db.prepare(`PRAGMA table_info(route_segments)`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const copyCols = ROUTE_SEGMENTS_EXPECTED_COLUMNS.filter((c) => liveCols.has(c));
    const copyList = copyCols.join(', ');

    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'route_segments' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE route_segments_new (${ROUTE_SEGMENTS_COLUMNS_SQLITE})`);
      db.exec(`
        INSERT INTO route_segments_new (${copyList})
        SELECT ${copyList} FROM route_segments
      `);
      db.exec(`DROP TABLE route_segments`);
      db.exec(`ALTER TABLE route_segments_new RENAME TO route_segments`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 045 (SQLite): failed to recreate index ${idx.name}:`, err);
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

    logger.info('Migration 045 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 045 down: not implemented (re-adding the broken FK is undesirable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration045Postgres(_client: any): Promise<void> {
  logger.debug('Migration 045 (PostgreSQL): no-op (no legacy route_segments FK on PG)');
}

// ============ MySQL ============

export async function runMigration045Mysql(_pool: any): Promise<void> {
  logger.debug('Migration 045 (MySQL): no-op (no legacy route_segments FK on MySQL)');
}
