/**
 * Migration 086: Add auto_distance_delete_log table
 * Stores history of automatic distance-based node cleanup runs.
 */

import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

export function runMigration086Sqlite(db: Database): void {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='auto_distance_delete_log'"
  ).get();

  if (!tableExists) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
        ON auto_distance_delete_log(timestamp DESC)
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (SQLite)');
  }
}

export async function runMigration086Postgres(client: PoolClient): Promise<void> {
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'auto_distance_delete_log'
  `);

  if (tableCheck.rows.length === 0) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at BIGINT
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
        ON auto_distance_delete_log(timestamp DESC)
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (PostgreSQL)');
  }
}

export async function runMigration086Mysql(pool: MySQLPool): Promise<void> {
  const [rows] = await pool.query(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_distance_delete_log'
  `);

  if ((rows as any[]).length === 0) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        nodes_deleted INT NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at BIGINT,
        INDEX idx_auto_distance_delete_log_timestamp (timestamp DESC)
      )
    `);
    logger.info('✅ Migration 086: Created auto_distance_delete_log table (MySQL)');
  }
}
