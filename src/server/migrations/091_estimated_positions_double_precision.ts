/**
 * Migration 091: Upgrade estimated_positions lat/lon/uncertaintyKm to DOUBLE PRECISION (PG only).
 *
 * The estimated_positions table was created with REAL columns in PostgreSQL, which is
 * only 32-bit (~7 significant digits). GPS coordinates typically need ~9 significant
 * digits to avoid visible position jumps. This migration promotes all three numeric
 * columns to DOUBLE PRECISION (64-bit), matching the existing nodes table schema
 * and fixing issue #3513.
 *
 * SQLite: REAL is already 64-bit in SQLite — no change needed.
 * MySQL:  Already uses DOUBLE — no change needed.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 091';
const TABLE = 'estimated_positions';

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    // SQLite REAL is 64-bit IEEE 754 — no schema change required.
    logger.info(`${LABEL} (SQLite): no-op (REAL is already 64-bit in SQLite)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration091Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): upgrading ${TABLE} coordinate columns to DOUBLE PRECISION...`);
  for (const col of ['latitude', 'longitude', 'uncertaintyKm']) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      await client.query(
        `ALTER TABLE ${TABLE} ALTER COLUMN "${col}" TYPE DOUBLE PRECISION`
      );
      logger.info(`${LABEL} (PostgreSQL): ${col} → DOUBLE PRECISION`);
    } catch (e: any) {
      // Already DOUBLE PRECISION — safe to ignore
      if (e.message?.includes('cannot be cast') || e.message?.includes('already')) {
        logger.debug(`${LABEL} (PostgreSQL): ${col} already DOUBLE PRECISION, skipping`);
      } else {
        throw e;
      }
    }
  }
}

// ============ MySQL ============

export async function runMigration091Mysql(_pool: any): Promise<void> {
  // MySQL already uses DOUBLE for these columns — no change needed.
  logger.info(`${LABEL} (MySQL): no-op (columns are already DOUBLE)`);
}
