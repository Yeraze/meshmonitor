/**
 * Migration 078: Widen meshcore_packet_log timestamp/createdAt to BIGINT.
 *
 * Migration 075 created these columns as 32-bit INTEGER on PostgreSQL/MySQL,
 * but they hold JS ms-epoch timestamps (Date.now() ~= 1.8e12), which overflow
 * the signed 32-bit range (~2.1e9). On PostgreSQL the retention cleanup
 * (`DELETE ... WHERE timestamp < $1`) failed with `value out of range for type
 * integer` (SQLSTATE 22003); inserts of post-2038-style values would fail too.
 *
 * SQLite is unaffected — its INTEGER storage class is dynamically 64-bit — so
 * the SQLite branch is a no-op.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (re-running the ALTER on an
 * already-BIGINT column is a harmless no-op).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 078';
const TABLE = 'meshcore_packet_log';

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    // SQLite INTEGER is dynamically sized (up to 64-bit), so ms-epoch values
    // never overflowed. Nothing to alter.
    logger.info(`${LABEL} (SQLite): no-op (INTEGER already 64-bit capable)`);
  },

  down: (_db: Database): void => {
    logger.info(`${LABEL} down (SQLite): no-op`);
  },
};

// ============ PostgreSQL ============

export async function runMigration078PacketLogBigintPostgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): widening ${TABLE}.timestamp/createdAt to BIGINT...`);

  await client.query(
    `ALTER TABLE ${TABLE}
       ALTER COLUMN "timestamp" TYPE BIGINT,
       ALTER COLUMN "createdAt" TYPE BIGINT`,
  );

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration078PacketLogBigintMysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): widening ${TABLE}.timestamp/createdAt to BIGINT...`);

  const conn = await pool.getConnection();
  try {
    await conn.query(
      `ALTER TABLE ${TABLE}
         MODIFY COLUMN timestamp BIGINT NOT NULL,
         MODIFY COLUMN createdAt BIGINT NOT NULL`,
    );
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
