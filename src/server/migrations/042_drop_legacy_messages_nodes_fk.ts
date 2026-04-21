/**
 * Migration 042: Drop legacy `messages.fromNodeNum`/`toNodeNum` REFERENCES
 * `nodes(nodeNum)` FKs.
 *
 * Context:
 *   Legacy SQLite databases created by pre-baseline Drizzle pushes carry
 *   foreign key declarations on `messages.fromNodeNum` and `messages.toNodeNum`
 *   pointing at `nodes(nodeNum)`. Migration 029 rebuilt `nodes` with a
 *   composite PRIMARY KEY (nodeNum, sourceId), which makes those FKs
 *   structurally invalid — any DML on `messages` with foreign_keys=ON raises:
 *
 *     SqliteError: foreign key mismatch - "messages" referencing "nodes"
 *
 *   Follows the same approach as 041 (telemetry): rebuild the table once
 *   without the FKs so future migrations don't need to toggle
 *   foreign_keys=OFF on every call site.
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

// Columns expected on `messages` per current Drizzle schema
// (src/db/schema/messages.ts). Order mirrors the schema declaration order.
const MESSAGES_COLUMNS_SQLITE = `
  id TEXT PRIMARY KEY,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  text TEXT NOT NULL,
  channel INTEGER NOT NULL DEFAULT 0,
  portnum INTEGER,
  requestId INTEGER,
  timestamp INTEGER NOT NULL,
  rxTime INTEGER,
  hopStart INTEGER,
  hopLimit INTEGER,
  relayNode INTEGER,
  replyId INTEGER,
  emoji INTEGER,
  viaMqtt INTEGER,
  viaStoreForward INTEGER,
  rxSnr REAL,
  rxRssi REAL,
  ackFailed INTEGER,
  routingErrorReceived INTEGER,
  deliveryState TEXT,
  wantAck INTEGER,
  ackFromNode INTEGER,
  createdAt INTEGER NOT NULL,
  decrypted_by TEXT,
  sourceId TEXT
`;

const MESSAGES_EXPECTED_COLUMNS = [
  'id', 'fromNodeNum', 'toNodeNum', 'fromNodeId', 'toNodeId', 'text', 'channel',
  'portnum', 'requestId', 'timestamp', 'rxTime', 'hopStart', 'hopLimit',
  'relayNode', 'replyId', 'emoji', 'viaMqtt', 'viaStoreForward', 'rxSnr',
  'rxRssi', 'ackFailed', 'routingErrorReceived', 'deliveryState', 'wantAck',
  'ackFromNode', 'createdAt', 'decrypted_by', 'sourceId',
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const fkRows = db.prepare(`PRAGMA foreign_key_list(messages)`).all() as Array<{
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
      logger.debug('Migration 042 (SQLite): no legacy messages→nodes FK present, skipping');
      return;
    }

    logger.info('Migration 042 (SQLite): rebuilding messages to drop legacy FK to nodes(nodeNum)...');

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) {
      db.pragma('legacy_alter_table = ON');
    }

    // Intersect expected columns with live columns so upgrades from odd
    // migration histories still work.
    const liveCols = new Set(
      (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    const copyCols = MESSAGES_EXPECTED_COLUMNS.filter((c) => liveCols.has(c));
    const copyList = copyCols.join(', ');

    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE messages_new (${MESSAGES_COLUMNS_SQLITE})`);
      db.exec(`
        INSERT INTO messages_new (${copyList})
        SELECT ${copyList} FROM messages
      `);
      db.exec(`DROP TABLE messages`);
      db.exec(`ALTER TABLE messages_new RENAME TO messages`);

      for (const idx of existingIndexes) {
        if (idx.name.startsWith('sqlite_autoindex_')) continue;
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 042 (SQLite): failed to recreate index ${idx.name}:`, err);
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

    logger.info('Migration 042 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 042 down: not implemented (re-adding the broken FK is undesirable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration042Postgres(_client: any): Promise<void> {
  logger.debug('Migration 042 (PostgreSQL): no-op (no legacy messages FK on PG)');
}

// ============ MySQL ============

export async function runMigration042Mysql(_pool: any): Promise<void> {
  logger.debug('Migration 042 (MySQL): no-op (no legacy messages FK on MySQL)');
}
