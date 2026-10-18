/**
 * Migration 211: create `mqtt_broker_presets` (issue #5794).
 *
 * MQTT brokers an admin saved for reuse across the Meshtastic MQTT forms.
 * GLOBAL by design — no sourceId: one broker serves many sources.
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 211';
const TABLE = 'mqtt_broker_presets';
const NAME_INDEX = 'mqtt_broker_presets_name_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        tls INTEGER NOT NULL DEFAULT 0,
        username TEXT,
        password TEXT,
        rootTopic TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${NAME_INDEX} ON ${TABLE}(name)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration211Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      tls BOOLEAN NOT NULL DEFAULT false,
      username TEXT,
      password TEXT,
      "rootTopic" TEXT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${NAME_INDEX} ON ${TABLE}(name)`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration211Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      host VARCHAR(255) NOT NULL,
      port INT NOT NULL,
      tls BOOLEAN NOT NULL DEFAULT false,
      username VARCHAR(255),
      password VARCHAR(255),
      rootTopic VARCHAR(255),
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY ${NAME_INDEX} (name)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
