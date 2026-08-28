/**
 * Migration 154: create `mesh_issues` (Mesh Issues Analysis epic #4964,
 * Phase 1 WP1).
 *
 * GLOBAL by design — no `sourceId` column. See the header comment on
 * `src/db/schema/meshIssues.ts` for the identity model
 * (`(issueType, subjectKey)`) and the reasoning for the non-null
 * `subjectKey` column instead of a nullable `nodeNum`-only key.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. Pure `CREATE ... IF NOT
 * EXISTS` — no backfill; the table starts empty and is populated by the
 * scheduled `meshIssuesAnalysisService` going forward.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 154';
const TABLE = 'mesh_issues';
const UNIQUE_INDEX = 'mesh_issues_type_subject_uniq';
const STATUS_INDEX = 'mesh_issues_status_idx';
const NODE_INDEX = 'mesh_issues_node_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issueType TEXT NOT NULL,
        subjectKey TEXT NOT NULL,
        nodeNum INTEGER,
        severity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence TEXT NOT NULL,
        sourceIds TEXT NOT NULL,
        firstDetected INTEGER NOT NULL,
        lastDetected INTEGER NOT NULL,
        cleanRuns INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        closedAt INTEGER,
        dismissed INTEGER NOT NULL DEFAULT 0,
        dismissedAt INTEGER,
        dismissedBy INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(issueType, subjectKey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${STATUS_INDEX} ON ${TABLE}(status, severity)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${NODE_INDEX} ON ${TABLE}(nodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration154Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "issueType" TEXT NOT NULL,
      "subjectKey" TEXT NOT NULL,
      "nodeNum" BIGINT,
      severity TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence TEXT NOT NULL,
      "sourceIds" TEXT NOT NULL,
      "firstDetected" BIGINT NOT NULL,
      "lastDetected" BIGINT NOT NULL,
      "cleanRuns" INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      "closedAt" BIGINT,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      "dismissedAt" BIGINT,
      "dismissedBy" INTEGER,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("issueType", "subjectKey")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${STATUS_INDEX} ON ${TABLE}(status, severity)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${NODE_INDEX} ON ${TABLE}("nodeNum")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration154Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      issueType VARCHAR(64) NOT NULL,
      subjectKey VARCHAR(128) NOT NULL,
      nodeNum BIGINT,
      severity VARCHAR(16) NOT NULL,
      confidence VARCHAR(16) NOT NULL,
      evidence TEXT NOT NULL,
      sourceIds TEXT NOT NULL,
      firstDetected BIGINT NOT NULL,
      lastDetected BIGINT NOT NULL,
      cleanRuns INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      closedAt BIGINT,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      dismissedAt BIGINT,
      dismissedBy INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (issueType, subjectKey),
      INDEX ${STATUS_INDEX} (status, severity),
      INDEX ${NODE_INDEX} (nodeNum)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
