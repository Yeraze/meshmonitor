/**
 * Migration 159: the `node_identity_merges` journal (issue #5032).
 *
 * Meshtastic 2.8 derives a node's number from its public key, so an upgrading
 * node reappears under a new number with its whole history orphaned under the
 * old one. The merge tool re-keys that history onto the new number — the most
 * destructive write path in the application — and this table is what makes it
 * reversible.
 *
 * Each row is one merge: who ran it, which two node numbers, how many rows
 * moved, and a JSON `journal` describing every re-key, delete and replace in
 * enough detail to run the merge backwards. The journal is written inside the
 * merge's own transaction, because after the merge nothing in the data
 * distinguishes a re-keyed row from one that always belonged to the survivor.
 *
 * `journal` is LONGTEXT on MySQL, not TEXT. MySQL's TEXT caps at 64 KiB and
 * truncates silently in non-strict mode — a truncated undo tape is an undo that
 * corrupts instead of refusing, which is worse than having no undo at all.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 * SQLite and PostgreSQL get native `CREATE TABLE IF NOT EXISTS` /
 * `CREATE INDEX IF NOT EXISTS`; MySQL has neither for indexes, so it goes
 * through the `information_schema` helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 159';
const TABLE = 'node_identity_merges';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT,
        toNodeId TEXT,
        basis TEXT NOT NULL,
        mergedAt INTEGER NOT NULL,
        mergedBy TEXT,
        rowsRekeyed INTEGER NOT NULL DEFAULT 0,
        rowsDropped INTEGER NOT NULL DEFAULT 0,
        undoable INTEGER NOT NULL DEFAULT 1,
        undoBlockedReason TEXT,
        undoneAt INTEGER,
        undoneBy TEXT,
        journalVersion INTEGER NOT NULL DEFAULT 1,
        journal TEXT NOT NULL
      )
    `);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_node_identity_merges_source ON ${TABLE} (sourceId, mergedAt)`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (dropping the undo journal is destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration159Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "fromNodeNum" BIGINT NOT NULL,
      "toNodeNum" BIGINT NOT NULL,
      "fromNodeId" TEXT,
      "toNodeId" TEXT,
      basis TEXT NOT NULL,
      "mergedAt" BIGINT NOT NULL,
      "mergedBy" TEXT,
      "rowsRekeyed" INTEGER NOT NULL DEFAULT 0,
      "rowsDropped" INTEGER NOT NULL DEFAULT 0,
      undoable BOOLEAN NOT NULL DEFAULT TRUE,
      "undoBlockedReason" TEXT,
      "undoneAt" BIGINT,
      "undoneBy" TEXT,
      "journalVersion" INTEGER NOT NULL DEFAULT 1,
      journal TEXT NOT NULL
    )
  `);

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_node_identity_merges_source ON ${TABLE} ("sourceId", "mergedAt")`,
  );
}

// ============ MySQL ============

export async function runMigration159Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  // The index is declared inline: MySQL has no CREATE INDEX IF NOT EXISTS, and
  // `createTableIfMissingMysql` already guards the whole statement.
  await createTableIfMissingMysql(
    pool,
    TABLE,
    `CREATE TABLE ${TABLE} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      sourceId VARCHAR(191) NOT NULL,
      fromNodeNum BIGINT NOT NULL,
      toNodeNum BIGINT NOT NULL,
      fromNodeId VARCHAR(32),
      toNodeId VARCHAR(32),
      basis VARCHAR(32) NOT NULL,
      mergedAt BIGINT NOT NULL,
      mergedBy VARCHAR(191),
      rowsRekeyed INT NOT NULL DEFAULT 0,
      rowsDropped INT NOT NULL DEFAULT 0,
      undoable BOOLEAN NOT NULL DEFAULT TRUE,
      undoBlockedReason VARCHAR(64),
      undoneAt BIGINT,
      undoneBy VARCHAR(191),
      journalVersion INT NOT NULL DEFAULT 1,
      journal LONGTEXT NOT NULL,
      INDEX idx_node_identity_merges_source (sourceId, mergedAt)
    )`,
  );
}
