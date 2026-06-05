/**
 * Migration 077: Normalize historical MQTT telemetry keys
 *
 * MQTT ingestion previously stored environment/device/air-quality/power metrics
 * under group-prefixed protobuf keys (e.g. `environment.barometricPressure`)
 * instead of the canonical short keys serial ingestion uses (`pressure`). That
 * left MQTT-sourced environment data invisible in the UI. Ingestion is fixed
 * going forward; this migration rewrites already-stored dotted rows to the
 * canonical key and backfills the matching unit.
 *
 * Idempotent: re-running finds no remaining dotted rows and is a no-op. The
 * mapping comes from the same source of truth as the ingestion path
 * (MQTT_KEY_MIGRATIONS), so it can't drift.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3314
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { MQTT_KEY_MIGRATIONS } from '../utils/telemetryKeys.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 077 (SQLite): Normalizing historical MQTT telemetry keys...');

    const stmt = db.prepare('UPDATE telemetry SET telemetryType = ?, unit = ? WHERE telemetryType = ?');
    let updated = 0;
    const tx = db.transaction(() => {
      for (const m of MQTT_KEY_MIGRATIONS) {
        const info = stmt.run(m.to, m.unit, m.from);
        updated += info.changes;
      }
    });
    tx();

    logger.info(`Migration 077 complete (SQLite): rewrote ${updated} MQTT telemetry row(s) to canonical keys`);
  },

  down: (_db: Database): void => {
    logger.debug('Migration 077 down: Not implemented (data normalization is one-way)');
  },
};

// ============ PostgreSQL ============

export async function runMigration077Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 077 (PostgreSQL): Normalizing historical MQTT telemetry keys...');

  try {
    let updated = 0;
    for (const m of MQTT_KEY_MIGRATIONS) {
      const res = await client.query(
        'UPDATE telemetry SET "telemetryType" = $1, unit = $2 WHERE "telemetryType" = $3',
        [m.to, m.unit, m.from]
      );
      updated += res.rowCount ?? 0;
    }
    logger.info(`Migration 077 complete (PostgreSQL): rewrote ${updated} MQTT telemetry row(s) to canonical keys`);
  } catch (error: any) {
    logger.error('Migration 077 (PostgreSQL) failed:', error.message);
    throw error;
  }
}

// ============ MySQL ============

export async function runMigration077Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 077 (MySQL): Normalizing historical MQTT telemetry keys...');

  try {
    let updated = 0;
    for (const m of MQTT_KEY_MIGRATIONS) {
      const [res]: any = await pool.query(
        'UPDATE telemetry SET telemetryType = ?, unit = ? WHERE telemetryType = ?',
        [m.to, m.unit, m.from]
      );
      updated += res?.affectedRows ?? 0;
    }
    logger.info(`Migration 077 complete (MySQL): rewrote ${updated} MQTT telemetry row(s) to canonical keys`);
  } catch (error: any) {
    logger.error('Migration 077 (MySQL) failed:', error.message);
    throw error;
  }
}
