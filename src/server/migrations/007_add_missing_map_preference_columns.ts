/**
 * Migration 083: Add missing map preference columns to PostgreSQL/MySQL
 *
 * Migration 030 created user_map_preferences for SQLite with all columns,
 * but Postgres/MySQL tables were created by Drizzle schema with only base columns.
 * Migrations 031 (sorting), 063 (position_history_hours), 074 (meshcore_nodes),
 * and 076 (accuracy/estimated) added some columns but the core feature columns
 * (map_tileset, show_paths, show_neighbor_info, show_route, show_motion,
 * show_mqtt_nodes, show_animations) were never added to Postgres/MySQL.
 */

import Database from 'better-sqlite3';
import { PoolClient } from 'pg';
import { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

export function runMigration083Sqlite(db: Database.Database): void {
  // v3.7 baseline may not have these columns — add idempotently
  const columnsToAdd = [
    { name: 'map_tileset', type: 'TEXT' },
    { name: 'show_paths', type: 'INTEGER DEFAULT 0' },
    { name: 'show_neighbor_info', type: 'INTEGER DEFAULT 0' },
    { name: 'show_route', type: 'INTEGER DEFAULT 1' },
    { name: 'show_motion', type: 'INTEGER DEFAULT 1' },
    { name: 'show_mqtt_nodes', type: 'INTEGER DEFAULT 1' },
    { name: 'show_meshcore_nodes', type: 'INTEGER DEFAULT 1' },
    { name: 'show_animations', type: 'INTEGER DEFAULT 0' },
    { name: 'show_accuracy_regions', type: 'INTEGER DEFAULT 0' },
    { name: 'show_estimated_positions', type: 'INTEGER DEFAULT 0' },
    { name: 'position_history_hours', type: 'INTEGER' },
  ];

  for (const col of columnsToAdd) {
    try {
      db.exec(`ALTER TABLE user_map_preferences ADD COLUMN ${col.name} ${col.type}`);
      logger.debug(`✅ Added ${col.name} column to user_map_preferences`);
    } catch {
      // Column already exists — ignore
    }
  }

  // Also ensure user_id column exists (baseline may have userId instead)
  try {
    db.exec(`ALTER TABLE user_map_preferences ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    // If we added user_id, populate from userId
    db.exec(`UPDATE user_map_preferences SET user_id = userId WHERE user_id IS NULL`);
    logger.debug('✅ Added user_id column to user_map_preferences');
  } catch {
    // Column already exists — ignore
  }

  logger.debug('Migration 083: SQLite map preference columns ensured.');
}

export async function runMigration083Postgres(client: PoolClient): Promise<void> {
  logger.info('Running migration 083: Add missing map preference columns (PostgreSQL)');

  const columnsToAdd = [
    { name: 'map_tileset', type: 'TEXT' },
    { name: 'show_paths', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_neighbor_info', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_route', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_motion', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_mqtt_nodes', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_meshcore_nodes', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_animations', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_accuracy_regions', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_estimated_positions', type: 'BOOLEAN DEFAULT false' },
    { name: 'position_history_hours', type: 'INTEGER' },
    { name: 'created_at', type: 'BIGINT' },
  ];

  for (const col of columnsToAdd) {
    const exists = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'user_map_preferences' AND column_name = $1`,
      [col.name]
    );

    if (exists.rows.length === 0) {
      await client.query(`ALTER TABLE user_map_preferences ADD COLUMN ${col.name} ${col.type}`);
      logger.debug(`✅ Added ${col.name} column to user_map_preferences`);
    }
  }

  logger.info('✅ Migration 083 completed: map preference columns added');
}

export async function runMigration083Mysql(pool: MySQLPool): Promise<void> {
  logger.info('Running migration 083: Add missing map preference columns (MySQL)');

  const columnsToAdd = [
    { name: 'map_tileset', type: 'VARCHAR(255)' },
    { name: 'show_paths', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_neighbor_info', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_route', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_motion', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_mqtt_nodes', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_meshcore_nodes', type: 'BOOLEAN DEFAULT true' },
    { name: 'show_animations', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_accuracy_regions', type: 'BOOLEAN DEFAULT false' },
    { name: 'show_estimated_positions', type: 'BOOLEAN DEFAULT false' },
    { name: 'position_history_hours', type: 'INTEGER' },
    { name: 'created_at', type: 'BIGINT' },
  ];

  for (const col of columnsToAdd) {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = 'user_map_preferences' AND COLUMN_NAME = ?`,
      [col.name]
    );

    if ((rows as any[]).length === 0) {
      await pool.query(`ALTER TABLE user_map_preferences ADD COLUMN ${col.name} ${col.type}`);
      logger.debug(`✅ Added ${col.name} column to user_map_preferences`);
    }
  }

  logger.info('✅ Migration 083 completed: map preference columns added');
}
