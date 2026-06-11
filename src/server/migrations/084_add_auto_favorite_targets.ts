/**
 * Migration 084: Automated Remote Favorites Management (issue #2608).
 *
 * Creates two per-source, per-target tables:
 *   - auto_favorite_targets:     one config row per remote target node.
 *   - auto_favorite_assignments: ledger of favorites assigned per target.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 084';
const TARGETS = 'auto_favorite_targets';
const ASSIGNMENTS = 'auto_favorite_assignments';
const DEFAULT_ROLES = '[2,11,12]';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TARGETS} + ${ASSIGNMENTS}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TARGETS} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        targetNodeNum INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        useNeighborInfo INTEGER NOT NULL DEFAULT 1,
        useTraceroutes INTEGER NOT NULL DEFAULT 1,
        intervalHours INTEGER NOT NULL DEFAULT 24,
        maxNewPerCycle INTEGER NOT NULL DEFAULT 1,
        maxRefavoritePerCycle INTEGER NOT NULL DEFAULT 1,
        eligibleRoles TEXT NOT NULL DEFAULT '${DEFAULT_ROLES}',
        lastRunAt INTEGER,
        lastNeighborRequestAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS aft_source_target_uniq ON ${TARGETS}(sourceId, targetNodeNum)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${ASSIGNMENTS} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        targetNodeNum INTEGER NOT NULL,
        favoriteNodeNum INTEGER NOT NULL,
        discoverySource TEXT,
        firstAssignedAt INTEGER NOT NULL,
        lastAssignedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS afa_source_target_fav_uniq ON ${ASSIGNMENTS}(sourceId, targetNodeNum, favoriteNodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TARGETS} + ${ASSIGNMENTS}`);
    db.exec(`DROP TABLE IF EXISTS ${ASSIGNMENTS}`);
    db.exec(`DROP TABLE IF EXISTS ${TARGETS}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration084Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TARGETS} + ${ASSIGNMENTS}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TARGETS} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "targetNodeNum" BIGINT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      "useNeighborInfo" BOOLEAN NOT NULL DEFAULT TRUE,
      "useTraceroutes" BOOLEAN NOT NULL DEFAULT TRUE,
      "intervalHours" INTEGER NOT NULL DEFAULT 24,
      "maxNewPerCycle" INTEGER NOT NULL DEFAULT 1,
      "maxRefavoritePerCycle" INTEGER NOT NULL DEFAULT 1,
      "eligibleRoles" TEXT NOT NULL DEFAULT '${DEFAULT_ROLES}',
      "lastRunAt" BIGINT,
      "lastNeighborRequestAt" BIGINT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS aft_source_target_uniq ON ${TARGETS}("sourceId", "targetNodeNum")`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${ASSIGNMENTS} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "targetNodeNum" BIGINT NOT NULL,
      "favoriteNodeNum" BIGINT NOT NULL,
      "discoverySource" TEXT,
      "firstAssignedAt" BIGINT NOT NULL,
      "lastAssignedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS afa_source_target_fav_uniq ON ${ASSIGNMENTS}("sourceId", "targetNodeNum", "favoriteNodeNum")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration084Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TARGETS} + ${ASSIGNMENTS}...`);

  const conn = await pool.getConnection();
  try {
    const [targetsExist] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TARGETS],
    );
    if ((targetsExist as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TARGETS} (
          id SERIAL PRIMARY KEY,
          sourceId VARCHAR(36) NOT NULL,
          targetNodeNum BIGINT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          useNeighborInfo BOOLEAN NOT NULL DEFAULT TRUE,
          useTraceroutes BOOLEAN NOT NULL DEFAULT TRUE,
          intervalHours INT NOT NULL DEFAULT 24,
          maxNewPerCycle INT NOT NULL DEFAULT 1,
          maxRefavoritePerCycle INT NOT NULL DEFAULT 1,
          eligibleRoles VARCHAR(255) NOT NULL DEFAULT '${DEFAULT_ROLES}',
          lastRunAt BIGINT,
          lastNeighborRequestAt BIGINT,
          createdAt BIGINT NOT NULL,
          updatedAt BIGINT NOT NULL,
          UNIQUE KEY aft_source_target_uniq (sourceId, targetNodeNum)
        )
      `);
    } else {
      logger.debug(`${TARGETS} already exists, skipping create`);
    }

    const [assignExist] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [ASSIGNMENTS],
    );
    if ((assignExist as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${ASSIGNMENTS} (
          id SERIAL PRIMARY KEY,
          sourceId VARCHAR(36) NOT NULL,
          targetNodeNum BIGINT NOT NULL,
          favoriteNodeNum BIGINT NOT NULL,
          discoverySource VARCHAR(32),
          firstAssignedAt BIGINT NOT NULL,
          lastAssignedAt BIGINT NOT NULL,
          UNIQUE KEY afa_source_target_fav_uniq (sourceId, targetNodeNum, favoriteNodeNum)
        )
      `);
    } else {
      logger.debug(`${ASSIGNMENTS} already exists, skipping create`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
