/**
 * Migration 163: widen `meshcore_messages.snr` and `meshcore_heard_repeaters.snr`
 * from INTEGER to REAL/DOUBLE (issue #5175).
 *
 * MeshCore SNR is a quarter-dB LoRa value decoded from the companion wire
 * format (`[snr:int8 quarter-dB]` divided by 4 — see meshcoreCompanionCodec.ts
 * and meshcoreManager.ts), so it is routinely fractional (e.g. -8.25, 5.5,
 * 2.75). Both tables declared `snr` as a 32-bit INTEGER column, which on
 * PostgreSQL rejects the insert outright:
 *
 *   error: invalid input syntax for type integer: "-8.25"
 *
 * On MySQL the same insert silently truncates toward zero instead of
 * erroring; on SQLite INTEGER is dynamic-affinity and already stores the
 * float as-is, so only PostgreSQL/MySQL need an actual column change.
 *
 * `rssi` is unaffected — it's a plain signed dBm byte per the wire format and
 * stays INTEGER.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 163';
const COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'meshcore_messages', column: 'snr' },
  { table: 'meshcore_heard_repeaters', column: 'snr' },
];

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    // SQLite columns use dynamic type affinity: an INTEGER-affinity column
    // stores a REAL value as-is when the conversion would be lossy (e.g.
    // -8.25), so no schema change is needed here.
    logger.info(`${LABEL} (SQLite): no-op (INTEGER affinity already stores fractional values)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration163Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): widening meshcore snr columns to REAL...`);
  for (const { table, column } of COLUMNS) {

    const { rows } = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    const currentType: string | undefined = rows[0]?.data_type?.toLowerCase();
    if (currentType === undefined) {
      logger.debug(`${LABEL} (PostgreSQL): ${table}.${column} not found, skipping`);
      continue;
    }
    if (currentType === 'real' || currentType === 'double precision') {
      logger.debug(`${LABEL} (PostgreSQL): ${table}.${column} already ${currentType}, skipping`);
      continue;
    }

    await client.query(`ALTER TABLE ${table} ALTER COLUMN "${column}" TYPE REAL`);
    logger.info(`${LABEL} (PostgreSQL): ${table}.${column} widened from ${currentType} → REAL`);
  }
}

// ============ MySQL ============

export async function runMigration163Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): widening meshcore snr columns to DOUBLE...`);
  const conn = await pool.getConnection();
  try {
    for (const { table, column } of COLUMNS) {

      const [rows] = await conn.query(
        `SELECT DATA_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      const currentType: string | undefined = (rows as Array<{ DATA_TYPE?: string }>)[0]?.DATA_TYPE?.toLowerCase();
      if (currentType === undefined) {
        logger.debug(`${LABEL} (MySQL): ${table}.${column} not found, skipping`);
        continue;
      }
      if (currentType === 'double') {
        logger.debug(`${LABEL} (MySQL): ${table}.${column} already DOUBLE, skipping`);
        continue;
      }

      await conn.query(`ALTER TABLE ${table} MODIFY COLUMN \`${column}\` DOUBLE`);
      logger.info(`${LABEL} (MySQL): ${table}.${column} widened from ${currentType} → DOUBLE`);
    }
  } finally {
    conn.release();
  }
}
