/**
 * Migration 044: Drop legacy `traceroutes.fromNodeNum`/`toNodeNum` REFERENCES
 * `nodes(nodeNum)` FKs.
 *
 * Context:
 *   Legacy SQLite databases created by pre-baseline Drizzle pushes carry
 *   foreign key declarations on `traceroutes.fromNodeNum` and
 *   `traceroutes.toNodeNum` pointing at `nodes(nodeNum)`. Migration 029
 *   rebuilt `nodes` with a composite PRIMARY KEY (nodeNum, sourceId), which
 *   makes those FKs structurally invalid — any DML on `traceroutes` with
 *   foreign_keys=ON raises:
 *
 *     SqliteError: foreign key mismatch - "traceroutes" referencing "nodes"
 *
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

const TRACEROUTES_COLUMNS_SQLITE = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  route TEXT,
  routeBack TEXT,
  snrTowards TEXT,
  snrBack TEXT,
  routePositions TEXT,
  channel INTEGER,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  sourceId TEXT
`;

const TRACEROUTES_EXPECTED_COLUMNS = [
  'id', 'fromNodeNum', 'toNodeNum', 'fromNodeId', 'toNodeId', 'route',
  'routeBack', 'snrTowards', 'snrBack', 'routePositions', 'channel',
  'timestamp', 'createdAt', 'sourceId',
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const fkRows = db.prepare(`PRAGMA foreign_key_list(traceroutes)`).all() as Array<{
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
      logger.debug('Migration 044 (SQLite): no legacy traceroutes→nodes FK present, skipping');
      return;
    }

    logger.info('Migration 044 (SQLite): rebuilding traceroutes to drop legacy FK to nodes(nodeNum)...');

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    const liveCols = new Set(
      (db.prepare(`PRAGMA table_info(traceroutes)`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const copyCols = TRACEROUTES_EXPECTED_COLUMNS.filter((c) => liveCols.has(c));
    const copyList = copyCols.join(', ');

    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'traceroutes' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE traceroutes_new (${TRACEROUTES_COLUMNS_SQLITE})`);
      db.exec(`
        INSERT INTO traceroutes_new (${copyList})
        SELECT ${copyList} FROM traceroutes
      `);
      db.exec(`DROP TABLE traceroutes`);
      db.exec(`ALTER TABLE traceroutes_new RENAME TO traceroutes`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 044 (SQLite): failed to recreate index ${idx.name}:`, err);
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

    logger.info('Migration 044 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 044 down: not implemented (re-adding the broken FK is undesirable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration044Postgres(_client: any): Promise<void> {
  logger.debug('Migration 044 (PostgreSQL): no-op (no legacy traceroutes FK on PG)');
}

// ============ MySQL ============

export async function runMigration044Mysql(_pool: any): Promise<void> {
  logger.debug('Migration 044 (MySQL): no-op (no legacy traceroutes FK on MySQL)');
}
