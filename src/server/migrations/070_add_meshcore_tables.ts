/**
 * Migration 066: Add MeshCore tables
 *
 * Creates meshcore_nodes and meshcore_messages tables for MeshCore protocol support.
 * MeshCore uses public keys (64-char hex) as primary identifiers instead of
 * numeric node IDs like Meshtastic.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 066: Add MeshCore tables');

    try {
      // Check if meshcore_nodes table already exists
      const nodesTableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='meshcore_nodes'
      `).get();

      if (!nodesTableExists) {
        db.exec(`
          CREATE TABLE meshcore_nodes (
            publicKey TEXT PRIMARY KEY,
            name TEXT,
            advType INTEGER,
            txPower INTEGER,
            maxTxPower INTEGER,
            radioFreq REAL,
            radioBw REAL,
            radioSf INTEGER,
            radioCr INTEGER,
            latitude REAL,
            longitude REAL,
            altitude REAL,
            batteryMv INTEGER,
            uptimeSecs INTEGER,
            rssi INTEGER,
            snr REAL,
            lastHeard INTEGER,
            hasAdminAccess INTEGER DEFAULT 0,
            lastAdminCheck INTEGER,
            isLocalNode INTEGER DEFAULT 0,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
          )
        `);
        logger.debug('Created meshcore_nodes table');
      }

      // Check if meshcore_messages table already exists
      const messagesTableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='meshcore_messages'
      `).get();

      if (!messagesTableExists) {
        db.exec(`
          CREATE TABLE meshcore_messages (
            id TEXT PRIMARY KEY,
            fromPublicKey TEXT NOT NULL,
            toPublicKey TEXT,
            text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            rssi INTEGER,
            snr INTEGER,
            messageType TEXT DEFAULT 'text',
            delivered INTEGER DEFAULT 0,
            deliveredAt INTEGER,
            createdAt INTEGER NOT NULL
          )
        `);

        // Create index for message queries
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_meshcore_messages_timestamp ON meshcore_messages(timestamp)
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_meshcore_messages_from ON meshcore_messages(fromPublicKey)
        `);
        logger.debug('Created meshcore_messages table');
      }

      logger.debug('Migration 066 completed: MeshCore tables added');
    } catch (error) {
      logger.error('Migration 066 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 066 down: Remove MeshCore tables');

    try {
      db.exec(`DROP TABLE IF EXISTS meshcore_messages`);
      db.exec(`DROP TABLE IF EXISTS meshcore_nodes`);
      logger.debug('Migration 066 rollback completed');
    } catch (error) {
      logger.error('Migration 066 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add MeshCore tables
 */
export async function runMigration070Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 066 (PostgreSQL): Add MeshCore tables');

  try {
    // Check if meshcore_nodes table exists
    const nodesExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'meshcore_nodes'
      )
    `);

    if (!nodesExists.rows[0].exists) {
      await client.query(`
        CREATE TABLE meshcore_nodes (
          "publicKey" TEXT PRIMARY KEY,
          name TEXT,
          "advType" INTEGER,
          "txPower" INTEGER,
          "maxTxPower" INTEGER,
          "radioFreq" REAL,
          "radioBw" REAL,
          "radioSf" INTEGER,
          "radioCr" INTEGER,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          altitude DOUBLE PRECISION,
          "batteryMv" INTEGER,
          "uptimeSecs" BIGINT,
          rssi INTEGER,
          snr REAL,
          "lastHeard" BIGINT,
          "hasAdminAccess" BOOLEAN DEFAULT FALSE,
          "lastAdminCheck" BIGINT,
          "isLocalNode" BOOLEAN DEFAULT FALSE,
          "createdAt" BIGINT NOT NULL,
          "updatedAt" BIGINT NOT NULL
        )
      `);
      logger.debug('Created meshcore_nodes table (PostgreSQL)');
    }

    // Check if meshcore_messages table exists
    const messagesExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'meshcore_messages'
      )
    `);

    if (!messagesExists.rows[0].exists) {
      await client.query(`
        CREATE TABLE meshcore_messages (
          id TEXT PRIMARY KEY,
          "fromPublicKey" TEXT NOT NULL,
          "toPublicKey" TEXT,
          text TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          rssi INTEGER,
          snr INTEGER,
          "messageType" TEXT DEFAULT 'text',
          delivered BOOLEAN DEFAULT FALSE,
          "deliveredAt" BIGINT,
          "createdAt" BIGINT NOT NULL
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_meshcore_messages_timestamp ON meshcore_messages(timestamp)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_meshcore_messages_from ON meshcore_messages("fromPublicKey")
      `);
      logger.debug('Created meshcore_messages table (PostgreSQL)');
    }

    logger.debug('Migration 066 (PostgreSQL): MeshCore tables added');
  } catch (error) {
    logger.error('Migration 066 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add MeshCore tables
 */
export async function runMigration070Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 066 (MySQL): Add MeshCore tables');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if meshcore_nodes table exists
      const [nodesTables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes'
      `);

      if ((nodesTables as any[]).length === 0) {
        await connection.query(`
          CREATE TABLE meshcore_nodes (
            publicKey VARCHAR(64) PRIMARY KEY,
            name VARCHAR(255),
            advType INT,
            txPower INT,
            maxTxPower INT,
            radioFreq DOUBLE,
            radioBw DOUBLE,
            radioSf INT,
            radioCr INT,
            latitude DOUBLE,
            longitude DOUBLE,
            altitude DOUBLE,
            batteryMv INT,
            uptimeSecs BIGINT,
            rssi INT,
            snr DOUBLE,
            lastHeard BIGINT,
            hasAdminAccess BOOLEAN DEFAULT FALSE,
            lastAdminCheck BIGINT,
            isLocalNode BOOLEAN DEFAULT FALSE,
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL
          )
        `);
        logger.debug('Created meshcore_nodes table (MySQL)');
      }

      // Check if meshcore_messages table exists
      const [messagesTables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages'
      `);

      if ((messagesTables as any[]).length === 0) {
        await connection.query(`
          CREATE TABLE meshcore_messages (
            id VARCHAR(64) PRIMARY KEY,
            fromPublicKey VARCHAR(64) NOT NULL,
            toPublicKey VARCHAR(64),
            text TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            rssi INT,
            snr INT,
            messageType VARCHAR(32) DEFAULT 'text',
            delivered BOOLEAN DEFAULT FALSE,
            deliveredAt BIGINT,
            createdAt BIGINT NOT NULL,
            INDEX idx_meshcore_messages_timestamp (timestamp),
            INDEX idx_meshcore_messages_from (fromPublicKey)
          )
        `);
        logger.debug('Created meshcore_messages table (MySQL)');
      }

      logger.debug('Migration 066 (MySQL): MeshCore tables added');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 066 (MySQL) failed:', error);
    throw error;
  }
}
