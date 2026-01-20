/**
 * Migration 050: Add Channel Database tables
 *
 * Creates the channel_database and channel_database_permissions tables
 * to enable server-side decryption of encrypted packets using stored PSKs.
 *
 * Also adds decrypted_by and decrypted_channel_id columns to packet_log
 * to track which packets were decrypted and by what method.
 *
 * This enables:
 * - Storing unlimited channel configurations beyond the device's 8 slots
 * - Server-side decryption of encrypted packets using database channel keys
 * - Read-only access to decrypted content (no transmit capability)
 * - Per-user read permissions for database channels
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 050: Add Channel Database tables');

    try {
      // STEP 1: Create channel_database table
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_database (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          psk TEXT NOT NULL,
          psk_length INTEGER NOT NULL,
          description TEXT,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
          last_decrypted_at INTEGER,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (is_enabled IN (0, 1)),
          CHECK (psk_length IN (16, 32))
        )
      `);
      logger.debug('✅ Created channel_database table');

      // STEP 2: Create channel_database_permissions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_database_permissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel_database_id INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
          can_read INTEGER NOT NULL DEFAULT 0,
          granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          granted_at INTEGER NOT NULL,
          CHECK (can_read IN (0, 1)),
          UNIQUE(user_id, channel_database_id)
        )
      `);
      logger.debug('✅ Created channel_database_permissions table');

      // STEP 3: Create indices for efficient lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_channel_database_enabled ON channel_database(is_enabled);
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions(user_id);
        CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_channel ON channel_database_permissions(channel_database_id);
      `);
      logger.debug('✅ Created channel_database indices');

      // STEP 4: Add decryption tracking columns to packet_log
      // Check if columns already exist (in case of partial migration)
      const tableInfo = db.prepare('PRAGMA table_info(packet_log)').all() as { name: string }[];
      const columnNames = tableInfo.map(c => c.name);

      if (!columnNames.includes('decrypted_by')) {
        db.exec(`ALTER TABLE packet_log ADD COLUMN decrypted_by TEXT`);
        logger.debug('✅ Added decrypted_by column to packet_log');
      }

      if (!columnNames.includes('decrypted_channel_id')) {
        db.exec(`ALTER TABLE packet_log ADD COLUMN decrypted_channel_id INTEGER`);
        logger.debug('✅ Added decrypted_channel_id column to packet_log');
      }

      logger.debug('✅ Migration 050 completed successfully');
      logger.debug('ℹ️  Channel database feature is now available for server-side decryption');
    } catch (error: any) {
      logger.error('❌ Migration 050 failed:', error);
      throw error;
    }
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 050: Remove Channel Database tables');

    try {
      // Drop the tables (indices are dropped automatically)
      db.exec(`DROP TABLE IF EXISTS channel_database_permissions`);
      db.exec(`DROP TABLE IF EXISTS channel_database`);

      // Note: SQLite doesn't support DROP COLUMN easily in older versions
      // For safety, we leave the packet_log columns in place on rollback
      // They won't affect functionality and can be cleaned up manually if needed

      logger.debug('✅ Migration 050 reverted');
    } catch (error) {
      logger.error('❌ Migration 050 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add channel database tables and packet_log columns
 */
export async function runMigration050Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 050 (PostgreSQL): Add Channel Database tables');

  try {
    // Check if channel_database table already exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'channel_database'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      // Create channel_database table
      await client.query(`
        CREATE TABLE channel_database (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          psk TEXT NOT NULL,
          "pskLength" INTEGER NOT NULL,
          description TEXT,
          "isEnabled" BOOLEAN NOT NULL DEFAULT true,
          "decryptedPacketCount" INTEGER NOT NULL DEFAULT 0,
          "lastDecryptedAt" BIGINT,
          "createdBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
          "createdAt" BIGINT NOT NULL,
          "updatedAt" BIGINT NOT NULL
        )
      `);
      logger.debug('  Created channel_database table');

      // Create channel_database_permissions table
      await client.query(`
        CREATE TABLE channel_database_permissions (
          id SERIAL PRIMARY KEY,
          "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          "channelDatabaseId" INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
          "canRead" BOOLEAN NOT NULL DEFAULT false,
          "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
          "grantedAt" BIGINT NOT NULL,
          UNIQUE("userId", "channelDatabaseId")
        )
      `);
      logger.debug('  Created channel_database_permissions table');

      // Create indices
      await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_database_enabled ON channel_database("isEnabled")`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions("userId")`);
      logger.debug('  Created indices');
    }

    // Check and add packet_log columns
    const columnCheck = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'packet_log'
        AND column_name IN ('decrypted_by', 'decrypted_channel_id')
    `);

    const existingColumns = new Set(columnCheck.rows.map((r: { column_name: string }) => r.column_name));

    if (!existingColumns.has('decrypted_by')) {
      await client.query(`ALTER TABLE packet_log ADD COLUMN decrypted_by TEXT`);
      logger.debug('  Added decrypted_by column to packet_log');
    }

    if (!existingColumns.has('decrypted_channel_id')) {
      await client.query(`ALTER TABLE packet_log ADD COLUMN decrypted_channel_id INTEGER`);
      logger.debug('  Added decrypted_channel_id column to packet_log');
    }

    logger.debug('Migration 050 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 050 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add channel database tables and packet_log columns
 */
export async function runMigration050Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 050 (MySQL): Add Channel Database tables');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if channel_database table already exists
      const [tables] = await connection.query(`
        SELECT TABLE_NAME
        FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'channel_database'
      `);

      if ((tables as any[]).length === 0) {
        // Create channel_database table
        await connection.query(`
          CREATE TABLE channel_database (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            psk VARCHAR(255) NOT NULL,
            pskLength INT NOT NULL,
            description TEXT,
            isEnabled BOOLEAN NOT NULL DEFAULT true,
            decryptedPacketCount INT NOT NULL DEFAULT 0,
            lastDecryptedAt BIGINT,
            createdBy INT,
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL,
            INDEX idx_channel_database_enabled (isEnabled),
            FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        logger.debug('  Created channel_database table');

        // Create channel_database_permissions table
        await connection.query(`
          CREATE TABLE channel_database_permissions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            userId INT NOT NULL,
            channelDatabaseId INT NOT NULL,
            canRead BOOLEAN NOT NULL DEFAULT false,
            grantedBy INT,
            grantedAt BIGINT NOT NULL,
            UNIQUE KEY unique_user_channel (userId, channelDatabaseId),
            INDEX idx_channel_database_permissions_user (userId),
            FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (channelDatabaseId) REFERENCES channel_database(id) ON DELETE CASCADE,
            FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        logger.debug('  Created channel_database_permissions table');
      }

      // Check and add packet_log columns
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'packet_log'
          AND COLUMN_NAME IN ('decrypted_by', 'decrypted_channel_id')
      `);

      const existingColumns = new Set((columns as Array<{ COLUMN_NAME: string }>).map(r => r.COLUMN_NAME));

      if (!existingColumns.has('decrypted_by')) {
        await connection.query(`ALTER TABLE packet_log ADD COLUMN decrypted_by VARCHAR(16)`);
        logger.debug('  Added decrypted_by column to packet_log');
      }

      if (!existingColumns.has('decrypted_channel_id')) {
        await connection.query(`ALTER TABLE packet_log ADD COLUMN decrypted_channel_id INT`);
        logger.debug('  Added decrypted_channel_id column to packet_log');
      }

      logger.debug('Migration 050 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 050 (MySQL) failed:', error);
    throw error;
  }
}
