/**
 * Migration 096: Widen meshcore_neighbor_info timestamp columns to BIGINT (PG/MySQL only).
 *
 * The meshcore_neighbor_info table (created in migration 073) declared its
 * `timestamp` and `createdAt` columns as 32-bit INTEGER on PostgreSQL and INT
 * on MySQL. Both columns store millisecond-epoch values written via
 * `Date.now()` (see MeshCoreRepository.insertNeighborsBatch), e.g.
 * 1781969045993, which overflows signed 32-bit integers (max 2,147,483,647).
 *
 * Production PostgreSQL deployments crashed on MeshCoreRepository.getNeighbors
 * with:
 *   error: value "1781969045993" is out of range for type integer (22003)
 *
 * This migration promotes both columns to BIGINT, matching the convention
 * already used by the sibling meshcore_messages / meshcore_nodes /
 * meshcore_packet_log tables for ms-epoch columns.
 *
 * SQLite: INTEGER is a 64-bit / dynamically-typed affinity — no change needed.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 096';
const TABLE = 'meshcore_neighbor_info';
const COLUMNS = ['timestamp', 'createdAt'];

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    // SQLite INTEGER columns hold 64-bit signed values (up to 8 bytes) and use
    // dynamic type affinity — ms-epoch timestamps never overflowed here.
    logger.info(`${LABEL} (SQLite): no-op (INTEGER is already 64-bit in SQLite)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration096Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): widening ${TABLE} timestamp columns to BIGINT...`);
  for (const col of COLUMNS) {
    // Check information_schema first so the ALTER is idempotent (re-runnable).
    // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
    const { rows } = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [TABLE, col]
    );
    const currentType: string | undefined = rows[0]?.data_type?.toLowerCase();
    if (currentType === undefined) {
      logger.debug(`${LABEL} (PostgreSQL): ${TABLE}.${col} not found, skipping`);
      continue;
    }
    if (currentType === 'bigint') {
      logger.debug(`${LABEL} (PostgreSQL): ${col} already BIGINT, skipping`);
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
    await client.query(`ALTER TABLE ${TABLE} ALTER COLUMN "${col}" TYPE BIGINT`);
    logger.info(`${LABEL} (PostgreSQL): ${col} widened from ${currentType} → BIGINT`);
  }
}

// ============ MySQL ============

export async function runMigration096Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): widening ${TABLE} timestamp columns to BIGINT...`);
  const conn = await pool.getConnection();
  try {
    for (const col of COLUMNS) {
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      const [rows] = await conn.query(
        `SELECT DATA_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, col]
      );
      const currentType: string | undefined = (rows as any[])[0]?.DATA_TYPE?.toLowerCase();
      if (currentType === undefined) {
        logger.debug(`${LABEL} (MySQL): ${TABLE}.${col} not found, skipping`);
        continue;
      }
      if (currentType === 'bigint') {
        logger.debug(`${LABEL} (MySQL): ${col} already BIGINT, skipping`);
        continue;
      }
      // Both columns are NOT NULL in the original DDL; preserve that on MODIFY.
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      await conn.query(`ALTER TABLE ${TABLE} MODIFY COLUMN \`${col}\` BIGINT NOT NULL`);
      logger.info(`${LABEL} (MySQL): ${col} widened from ${currentType} → BIGINT`);
    }
  } finally {
    conn.release();
  }
}
