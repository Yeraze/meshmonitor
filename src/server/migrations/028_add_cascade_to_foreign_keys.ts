/**
 * Migration 028: Add CASCADE behavior to foreign keys
 *
 * This migration recreates tables with ON DELETE CASCADE constraints
 * to prevent foreign key violations when deleting nodes or users.
 *
 * Tables affected:
 * - messages: CASCADE delete when nodes are deleted
 * - traceroutes: CASCADE delete when nodes are deleted
 * - route_segments: CASCADE delete when nodes are deleted
 * - neighbor_info: CASCADE delete when nodes are deleted
 * - audit_log: SET NULL when users are deleted (preserve audit trail)
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 028: Add CASCADE to foreign keys');

    try {
      // SQLite doesn't support ALTER TABLE for foreign keys
      // We need to recreate each table with CASCADE constraints

      // Clean up any leftover tables from failed migrations
      db.exec(`DROP TABLE IF EXISTS messages_new`);
      db.exec(`DROP TABLE IF EXISTS traceroutes_new`);
      db.exec(`DROP TABLE IF EXISTS route_segments_new`);
      db.exec(`DROP TABLE IF EXISTS neighbor_info_new`);
      db.exec(`DROP TABLE IF EXISTS audit_log_new`);

      // 1. MESSAGES TABLE
      logger.debug('Recreating messages table with CASCADE...');

      // Get current column names dynamically
      const columnInfo = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const columns = columnInfo.map(col => col.name).join(', ');
      logger.debug(`Current messages columns: ${columns}`);

      // Create new messages table with CASCADE
      // Include all possible columns that may have been added by migrations
      db.exec(`
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          text TEXT NOT NULL,
          channel INTEGER NOT NULL DEFAULT 0,
          portnum INTEGER,
          timestamp INTEGER NOT NULL,
          rxTime INTEGER,
          hopStart INTEGER,
          hopLimit INTEGER,
          replyId INTEGER,
          emoji INTEGER,
          requestId INTEGER,
          ackFailed BOOLEAN DEFAULT 0,
          routingErrorReceived BOOLEAN DEFAULT 0,
          deliveryState TEXT,
          wantAck BOOLEAN DEFAULT 0,
          viaMqtt BOOLEAN DEFAULT 0,
          relayNode INTEGER,
          ackFromNode INTEGER,
          rxSnr REAL,
          rxRssi INTEGER,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        )
      `);

      // Copy data from old table using column list to handle missing columns
      db.exec(`
        INSERT INTO messages_new (${columns})
        SELECT ${columns} FROM messages
      `);

      // Drop old table and rename new one
      db.exec(`DROP TABLE messages`);
      db.exec(`ALTER TABLE messages_new RENAME TO messages`);

      // Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_fromNodeNum ON messages(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_messages_toNodeNum ON messages(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_replyId ON messages(replyId);
      `);

      logger.debug('✅ Messages table recreated with CASCADE');

      // 2. TRACEROUTES TABLE
      logger.debug('Recreating traceroutes table with CASCADE...');

      const traceroutesColumnInfo = db.prepare('PRAGMA table_info(traceroutes)').all() as Array<{ name: string }>;
      const traceroutesColumns = traceroutesColumnInfo.map(col => col.name).join(', ');

      db.exec(`
        CREATE TABLE traceroutes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          route TEXT,
          routeBack TEXT,
          snrTowards TEXT,
          snrBack TEXT,
          timestamp INTEGER NOT NULL,
          requestId INTEGER,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        )
      `);

      db.exec(`
        INSERT INTO traceroutes_new (${traceroutesColumns})
        SELECT ${traceroutesColumns} FROM traceroutes
      `);

      db.exec(`DROP TABLE traceroutes`);
      db.exec(`ALTER TABLE traceroutes_new RENAME TO traceroutes`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_traceroutes_fromNodeNum ON traceroutes(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_traceroutes_toNodeNum ON traceroutes(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_traceroutes_timestamp ON traceroutes(timestamp DESC);
      `);

      logger.debug('✅ Traceroutes table recreated with CASCADE');

      // 3. ROUTE_SEGMENTS TABLE
      logger.debug('Recreating route_segments table with CASCADE...');

      const routeSegmentsColumnInfo = db.prepare('PRAGMA table_info(route_segments)').all() as Array<{ name: string }>;
      const routeSegmentsColumns = routeSegmentsColumnInfo.map(col => col.name).join(', ');

      db.exec(`
        CREATE TABLE route_segments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          distanceKm REAL NOT NULL,
          isRecordHolder BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        )
      `);

      db.exec(`
        INSERT INTO route_segments_new (${routeSegmentsColumns})
        SELECT ${routeSegmentsColumns} FROM route_segments
      `);

      db.exec(`DROP TABLE route_segments`);
      db.exec(`ALTER TABLE route_segments_new RENAME TO route_segments`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_route_segments_fromNodeNum ON route_segments(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_route_segments_toNodeNum ON route_segments(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp DESC);
      `);

      logger.debug('✅ Route segments table recreated with CASCADE');

      // 4. NEIGHBOR_INFO TABLE
      logger.debug('Recreating neighbor_info table with CASCADE...');

      const neighborInfoColumnInfo = db.prepare('PRAGMA table_info(neighbor_info)').all() as Array<{ name: string }>;
      const neighborInfoColumns = neighborInfoColumnInfo.map(col => col.name).join(', ');

      db.exec(`
        CREATE TABLE neighbor_info_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL,
          neighborNodeNum INTEGER NOT NULL,
          snr REAL,
          lastRxTime INTEGER,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE,
          FOREIGN KEY (neighborNodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        )
      `);

      db.exec(`
        INSERT INTO neighbor_info_new (${neighborInfoColumns})
        SELECT ${neighborInfoColumns} FROM neighbor_info
      `);

      db.exec(`DROP TABLE neighbor_info`);
      db.exec(`ALTER TABLE neighbor_info_new RENAME TO neighbor_info`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_nodeNum ON neighbor_info(nodeNum);
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_neighborNodeNum ON neighbor_info(neighborNodeNum);
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_timestamp ON neighbor_info(timestamp DESC);
      `);

      logger.debug('✅ Neighbor info table recreated with CASCADE');

      // 5. AUDIT_LOG TABLE - Use SET NULL to preserve audit trail
      logger.debug('Recreating audit_log table with SET NULL...');

      const auditLogColumnInfo = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>;
      const auditLogColumns = auditLogColumnInfo.map(col => col.name).join(', ');

      db.exec(`
        CREATE TABLE audit_log_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip_address TEXT,
          timestamp INTEGER NOT NULL,
          value_before TEXT,
          value_after TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      db.exec(`
        INSERT INTO audit_log_new (${auditLogColumns})
        SELECT ${auditLogColumns} FROM audit_log
      `);

      db.exec(`DROP TABLE audit_log`);
      db.exec(`ALTER TABLE audit_log_new RENAME TO audit_log`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
      `);

      logger.debug('✅ Audit log table recreated with SET NULL');

      logger.debug('✅ Migration 028 completed: CASCADE constraints added');
    } catch (error: any) {
      logger.error('❌ Migration 028 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 028 down: Remove CASCADE constraints');

    try {
      // Recreate tables without CASCADE (original schema)

      // 1. MESSAGES TABLE
      db.exec(`
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          text TEXT NOT NULL,
          channel INTEGER NOT NULL DEFAULT 0,
          portnum INTEGER,
          timestamp INTEGER NOT NULL,
          rxTime INTEGER,
          hopStart INTEGER,
          hopLimit INTEGER,
          replyId INTEGER,
          emoji INTEGER,
          requestId INTEGER,
          ackFailed BOOLEAN DEFAULT 0,
          routingErrorReceived BOOLEAN DEFAULT 0,
          deliveryState TEXT,
          wantAck BOOLEAN DEFAULT 0,
          viaMqtt BOOLEAN DEFAULT 0,
          relayNode INTEGER,
          ackFromNode INTEGER,
          rxSnr REAL,
          rxRssi INTEGER,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        )
      `);

      db.exec(`INSERT INTO messages_new SELECT * FROM messages`);
      db.exec(`DROP TABLE messages`);
      db.exec(`ALTER TABLE messages_new RENAME TO messages`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_fromNodeNum ON messages(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_messages_toNodeNum ON messages(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_replyId ON messages(replyId);
      `);

      // 2. TRACEROUTES TABLE
      db.exec(`
        CREATE TABLE traceroutes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          route TEXT,
          routeBack TEXT,
          snrTowards TEXT,
          snrBack TEXT,
          timestamp INTEGER NOT NULL,
          requestId INTEGER,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        )
      `);

      db.exec(`INSERT INTO traceroutes_new SELECT * FROM traceroutes`);
      db.exec(`DROP TABLE traceroutes`);
      db.exec(`ALTER TABLE traceroutes_new RENAME TO traceroutes`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_traceroutes_fromNodeNum ON traceroutes(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_traceroutes_toNodeNum ON traceroutes(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_traceroutes_timestamp ON traceroutes(timestamp DESC);
      `);

      // 3. ROUTE_SEGMENTS TABLE
      db.exec(`
        CREATE TABLE route_segments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fromNodeNum INTEGER NOT NULL,
          toNodeNum INTEGER NOT NULL,
          fromNodeId TEXT NOT NULL,
          toNodeId TEXT NOT NULL,
          distanceKm REAL NOT NULL,
          isRecordHolder BOOLEAN DEFAULT 0,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
        )
      `);

      db.exec(`INSERT INTO route_segments_new SELECT * FROM route_segments`);
      db.exec(`DROP TABLE route_segments`);
      db.exec(`ALTER TABLE route_segments_new RENAME TO route_segments`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_route_segments_fromNodeNum ON route_segments(fromNodeNum);
        CREATE INDEX IF NOT EXISTS idx_route_segments_toNodeNum ON route_segments(toNodeNum);
        CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp DESC);
      `);

      // 4. NEIGHBOR_INFO TABLE
      db.exec(`
        CREATE TABLE neighbor_info_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL,
          neighborNodeNum INTEGER NOT NULL,
          snr REAL,
          lastRxTime INTEGER,
          timestamp INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum),
          FOREIGN KEY (neighborNodeNum) REFERENCES nodes(nodeNum)
        )
      `);

      db.exec(`INSERT INTO neighbor_info_new SELECT * FROM neighbor_info`);
      db.exec(`DROP TABLE neighbor_info`);
      db.exec(`ALTER TABLE neighbor_info_new RENAME TO neighbor_info`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_nodeNum ON neighbor_info(nodeNum);
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_neighborNodeNum ON neighbor_info(neighborNodeNum);
        CREATE INDEX IF NOT EXISTS idx_neighbor_info_timestamp ON neighbor_info(timestamp DESC);
      `);

      // 5. AUDIT_LOG TABLE
      db.exec(`
        CREATE TABLE audit_log_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          action TEXT NOT NULL,
          resource TEXT,
          details TEXT,
          ip_address TEXT,
          timestamp INTEGER NOT NULL,
          value_before TEXT,
          value_after TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);

      db.exec(`INSERT INTO audit_log_new SELECT * FROM audit_log`);
      db.exec(`DROP TABLE audit_log`);
      db.exec(`ALTER TABLE audit_log_new RENAME TO audit_log`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
        CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
      `);

      logger.debug('✅ Migration 028 rollback completed');
    } catch (error) {
      logger.error('❌ Migration 028 rollback failed:', error);
      throw error;
    }
  }
};
