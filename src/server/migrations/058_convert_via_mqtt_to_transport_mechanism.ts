/**
 * Migration 058: Convert via_mqtt to transport_mechanism
 *
 * Replaces the boolean via_mqtt column with an integer transport_mechanism column
 * that can represent the full TransportMechanism enum from Meshtastic protobufs:
 *   0 = INTERNAL (node generated the packet itself)
 *   1 = LORA (arrived via primary LoRa radio)
 *   2 = LORA_ALT1 (arrived via secondary LoRa radio)
 *   3 = LORA_ALT2 (arrived via tertiary LoRa radio)
 *   4 = LORA_ALT3 (arrived via quaternary LoRa radio)
 *   5 = MQTT (arrived via MQTT connection)
 *   6 = MULTICAST_UDP (arrived via Multicast UDP)
 *   7 = API (arrived via API connection)
 *
 * Existing via_mqtt values are converted:
 *   true (1) -> 5 (MQTT)
 *   false (0) -> 1 (LORA)
 *   NULL -> NULL
 *
 * Fixes issue #1619.
 */
import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 058: Convert via_mqtt to transport_mechanism');

    try {
      // Check which columns exist
      const tableInfo = db.prepare('PRAGMA table_info(packet_log)').all() as { name: string }[];
      const columnNames = tableInfo.map((col) => col.name);

      const hasViaMqtt = columnNames.includes('via_mqtt');
      const hasTransportMechanism = columnNames.includes('transport_mechanism');

      if (!hasTransportMechanism) {
        // Add transport_mechanism column
        db.exec(`ALTER TABLE packet_log ADD COLUMN transport_mechanism INTEGER`);
        logger.debug('✅ Added transport_mechanism column to packet_log table');

        // Convert existing via_mqtt values if the column exists
        if (hasViaMqtt) {
          // Convert: true (1) -> 5 (MQTT), false (0) -> 1 (LORA), NULL -> NULL
          db.exec(`
            UPDATE packet_log
            SET transport_mechanism = CASE
              WHEN via_mqtt = 1 THEN 5
              WHEN via_mqtt = 0 THEN 1
              ELSE NULL
            END
          `);
          logger.debug('✅ Converted via_mqtt values to transport_mechanism');
        }
      } else {
        logger.debug('ℹ️  transport_mechanism column already exists in packet_log table');
      }

      // Note: We don't drop via_mqtt column for backwards compatibility
      // It will be ignored going forward

      logger.debug('✅ Migration 058 completed successfully');
    } catch (error: any) {
      logger.error('❌ Migration 058 failed:', error);
      throw error;
    }
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 058: Convert transport_mechanism back to via_mqtt');

    try {
      // Note: SQLite doesn't support DROP COLUMN easily in older versions
      // For safety, we leave the column in place on rollback
      // The via_mqtt column should still exist and can be used
      logger.debug('ℹ️  Migration 058 rollback: transport_mechanism column left in place (SQLite limitation)');
    } catch (error) {
      logger.error('❌ Migration 058 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Convert via_mqtt to transport_mechanism
 */
export async function runMigration058Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 058 (PostgreSQL): Convert via_mqtt to transport_mechanism');

  try {
    // Check if transport_mechanism column exists
    const transportResult = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'packet_log'
        AND column_name = 'transport_mechanism'
    `);

    // Check if via_mqtt column exists
    const viaMqttResult = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'packet_log'
        AND column_name = 'via_mqtt'
    `);

    const hasTransportMechanism = transportResult.rows.length > 0;
    const hasViaMqtt = viaMqttResult.rows.length > 0;

    if (!hasTransportMechanism) {
      // Add transport_mechanism column
      await client.query(`ALTER TABLE packet_log ADD COLUMN transport_mechanism INTEGER`);
      logger.debug('  Added transport_mechanism column to packet_log table');

      // Convert existing via_mqtt values if the column exists
      if (hasViaMqtt) {
        // Convert: true -> 5 (MQTT), false -> 1 (LORA), NULL -> NULL
        await client.query(`
          UPDATE packet_log
          SET transport_mechanism = CASE
            WHEN via_mqtt = true THEN 5
            WHEN via_mqtt = false THEN 1
            ELSE NULL
          END
        `);
        logger.debug('  Converted via_mqtt values to transport_mechanism');
      }
    } else {
      logger.debug('  transport_mechanism column already exists in packet_log table');
    }

    logger.debug('Migration 058 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 058 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Convert via_mqtt to transport_mechanism
 */
export async function runMigration058Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 058 (MySQL): Convert via_mqtt to transport_mechanism');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if transport_mechanism column exists
      const [transportRows] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'packet_log'
        AND COLUMN_NAME = 'transport_mechanism'
      `) as [any[], any];

      // Check if via_mqtt column exists
      const [viaMqttRows] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'packet_log'
        AND COLUMN_NAME = 'via_mqtt'
      `) as [any[], any];

      const hasTransportMechanism = transportRows.length > 0;
      const hasViaMqtt = viaMqttRows.length > 0;

      if (!hasTransportMechanism) {
        // Add transport_mechanism column
        await connection.query(`ALTER TABLE packet_log ADD COLUMN transport_mechanism INT`);
        logger.debug('  Added transport_mechanism column to packet_log table');

        // Convert existing via_mqtt values if the column exists
        if (hasViaMqtt) {
          // Convert: true (1) -> 5 (MQTT), false (0) -> 1 (LORA), NULL -> NULL
          await connection.query(`
            UPDATE packet_log
            SET transport_mechanism = CASE
              WHEN via_mqtt = 1 THEN 5
              WHEN via_mqtt = 0 THEN 1
              ELSE NULL
            END
          `);
          logger.debug('  Converted via_mqtt values to transport_mechanism');
        }
      } else {
        logger.debug('  transport_mechanism column already exists in packet_log table');
      }

      logger.debug('Migration 058 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 058 (MySQL) failed:', error);
    throw error;
  }
}
