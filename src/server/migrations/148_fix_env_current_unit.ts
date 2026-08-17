/**
 * Migration 148: Fix the stored unit on historical `envCurrent` telemetry rows.
 *
 * The EnvironmentMetrics `current` field is populated by the firmware
 * INA219/INA260 drivers from `getCurrent_mA()` — it is milliamps, matching the
 * per-channel PowerMetrics currents (unit 'mA'). The canonical unit map
 * (`src/server/utils/telemetryKeys.ts`) mislabeled it 'A', and the unit is
 * stored per-row at ingest, so every historical `envCurrent` row carries the
 * wrong unit. Charts read the stored unit verbatim, so old rows kept showing
 * "(A)" even after the map was corrected.
 *
 * The stored *value* is already correct (raw mA, no scaling applied at ingest),
 * so this migration only rewrites the `unit` label — it never touches `value`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL: the `unit = 'A'` guard means a
 * re-run (e.g. after a crash between the migration and its ledger write) matches
 * zero rows once the labels are already 'mA'.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 148';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): relabeling envCurrent rows 'A' -> 'mA'...`);
    const result = db
      .prepare(`UPDATE telemetry SET unit = 'mA' WHERE telemetryType = 'envCurrent' AND unit = 'A'`)
      .run();
    logger.info(`${LABEL} complete (SQLite): ${result.changes} row(s) updated`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): reverting envCurrent rows 'mA' -> 'A'`);
    db.prepare(`UPDATE telemetry SET unit = 'A' WHERE telemetryType = 'envCurrent' AND unit = 'mA'`).run();
  },
};

// ============ PostgreSQL ============

export async function runMigration148Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): relabeling envCurrent rows 'A' -> 'mA'...`);
  const result = await client.query(
    `UPDATE telemetry SET "unit" = 'mA' WHERE "telemetryType" = 'envCurrent' AND "unit" = 'A'`
  );
  logger.info(`${LABEL} complete (PostgreSQL): ${result.rowCount ?? 0} row(s) updated`);
}

// ============ MySQL ============

export async function runMigration148Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): relabeling envCurrent rows 'A' -> 'mA'...`);
  const [result] = await pool.query(
    `UPDATE telemetry SET unit = 'mA' WHERE telemetryType = 'envCurrent' AND unit = 'A'`
  );
  const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
  logger.info(`${LABEL} complete (MySQL): ${affected} row(s) updated`);
}
