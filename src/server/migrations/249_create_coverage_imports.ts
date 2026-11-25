/**
 * Migration 249: Coverage import batches (#5891 Phase 3). PER-SOURCE.
 * Creates `coverage_imports` (one row per imported Coverage Report file) and
 * adds `coverage_receptions.importId` (null = live, set = imported) with a
 * partial index on SQLite/PG (plain index on MySQL, which has no partial
 * indexes). No foreign keys; the repository deletes reception rows first.
 * Idempotent on every backend. Spec: WALKABOUT_P3_SPEC.md §3.1.
 */
import type { Database } from 'better-sqlite3';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createIndexIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

const IMP = 'coverage_imports';
const RX = 'coverage_receptions';

export const migration = {
  up: (db: Database): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${IMP} (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        kind TEXT NOT NULL,
        format TEXT NOT NULL,
        filename TEXT NOT NULL,
        fileSha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        importedBy INTEGER,
        importedAt INTEGER NOT NULL,
        rowCount INTEGER NOT NULL,
        insertedCount INTEGER NOT NULL,
        duplicateCount INTEGER NOT NULL,
        skippedCount INTEGER NOT NULL,
        firstReceivedAt INTEGER,
        lastReceivedAt INTEGER,
        sourceTruncated INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS cov_imp_source_sha_uniq ON ${IMP}(sourceId, fileSha256)`);
    db.exec(`CREATE INDEX IF NOT EXISTS cov_imp_source_imported_idx ON ${IMP}(sourceId, importedAt)`);

    addColumnIfMissing(db, RX, 'importId', 'importId TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS cov_rx_import_idx ON ${RX}(importId) WHERE importId IS NOT NULL`);
  },
};

export async function runMigration249Postgres(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${IMP} (
      "id" TEXT PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "format" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "fileSha256" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "importedBy" INTEGER,
      "importedAt" BIGINT NOT NULL,
      "rowCount" INTEGER NOT NULL,
      "insertedCount" INTEGER NOT NULL,
      "duplicateCount" INTEGER NOT NULL,
      "skippedCount" INTEGER NOT NULL,
      "firstReceivedAt" BIGINT,
      "lastReceivedAt" BIGINT,
      "sourceTruncated" BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS cov_imp_source_sha_uniq ON ${IMP}("sourceId", "fileSha256")`);
  await client.query(`CREATE INDEX IF NOT EXISTS cov_imp_source_imported_idx ON ${IMP}("sourceId", "importedAt")`);

  await addColumnIfMissingPostgres(client, RX, 'importId', '"importId" TEXT');
  await client.query(`CREATE INDEX IF NOT EXISTS cov_rx_import_idx ON ${RX}("importId") WHERE "importId" IS NOT NULL`);
}

export async function runMigration249Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await createTableIfMissingMysql(pool, IMP, `
    CREATE TABLE ${IMP} (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      kind VARCHAR(24) NOT NULL,
      format VARCHAR(8) NOT NULL,
      filename VARCHAR(200) NOT NULL,
      fileSha256 VARCHAR(64) NOT NULL,
      status VARCHAR(12) NOT NULL,
      importedBy INT,
      importedAt BIGINT NOT NULL,
      rowCount INT NOT NULL,
      insertedCount INT NOT NULL,
      duplicateCount INT NOT NULL,
      skippedCount INT NOT NULL,
      firstReceivedAt BIGINT,
      lastReceivedAt BIGINT,
      sourceTruncated TINYINT(1) NOT NULL DEFAULT 0,
      UNIQUE KEY cov_imp_source_sha_uniq (sourceId, fileSha256),
      INDEX cov_imp_source_imported_idx (sourceId, importedAt)
    )
  `);
  await addColumnIfMissingMysql(pool, RX, 'importId', '`importId` VARCHAR(36) NULL');
  await createIndexIfMissingMysql(pool, RX, 'cov_rx_import_idx', `CREATE INDEX cov_rx_import_idx ON ${RX}(importId)`);
}
