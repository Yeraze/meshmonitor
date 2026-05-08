/**
 * Migration 053: Create waypoints table
 *
 * Per-source waypoint storage for Meshtastic WAYPOINT_APP (PortNum 8) packets.
 * Composite primary key (sourceId, waypointId) with FK to sources(id) ON DELETE CASCADE.
 *
 * Idempotent across SQLite/PostgreSQL/MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 053 (SQLite): Creating waypoints table...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS waypoints (
        source_id TEXT NOT NULL,
        waypoint_id INTEGER NOT NULL,
        owner_node_num INTEGER,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        expire_at INTEGER,
        locked_to INTEGER,
        name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon_codepoint INTEGER,
        icon_emoji TEXT,
        is_virtual INTEGER NOT NULL DEFAULT 0,
        rebroadcast_interval_s INTEGER,
        last_broadcast_at INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, waypoint_id),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_waypoints_source_expire ON waypoints(source_id, expire_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_waypoints_source_owner  ON waypoints(source_id, owner_node_num)`);

    logger.info('Migration 053 complete (SQLite)');
  },

  down: (db: Database): void => {
    logger.info('Running migration 053 down (SQLite): dropping waypoints');
    db.exec(`DROP TABLE IF EXISTS waypoints`);
  },
};

// ============ PostgreSQL ============

export async function runMigration053Postgres(client: any): Promise<void> {
  logger.info('Running migration 053 (PostgreSQL): Creating waypoints table...');

  await client.query(`
    CREATE TABLE IF NOT EXISTS waypoints (
      source_id TEXT NOT NULL,
      waypoint_id BIGINT NOT NULL,
      owner_node_num BIGINT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      expire_at BIGINT,
      locked_to BIGINT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon_codepoint INTEGER,
      icon_emoji TEXT,
      is_virtual INTEGER NOT NULL DEFAULT 0,
      rebroadcast_interval_s INTEGER,
      last_broadcast_at BIGINT,
      first_seen_at BIGINT NOT NULL,
      last_updated_at BIGINT NOT NULL,
      PRIMARY KEY (source_id, waypoint_id),
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_waypoints_source_expire ON waypoints(source_id, expire_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_waypoints_source_owner  ON waypoints(source_id, owner_node_num)`);

  logger.info('Migration 053 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration053Mysql(pool: any): Promise<void> {
  logger.info('Running migration 053 (MySQL): Creating waypoints table...');

  const conn = await pool.getConnection();
  try {
    // Check if table exists first to keep idempotency
    const [existRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'waypoints'`,
    );
    if ((existRows as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE waypoints (
          source_id VARCHAR(36) NOT NULL,
          waypoint_id BIGINT NOT NULL,
          owner_node_num BIGINT,
          latitude DOUBLE NOT NULL,
          longitude DOUBLE NOT NULL,
          expire_at BIGINT,
          locked_to BIGINT,
          name VARCHAR(64) NOT NULL DEFAULT '',
          description TEXT NOT NULL,
          icon_codepoint INT,
          icon_emoji VARCHAR(16),
          is_virtual INT NOT NULL DEFAULT 0,
          rebroadcast_interval_s INT,
          last_broadcast_at BIGINT,
          first_seen_at BIGINT NOT NULL,
          last_updated_at BIGINT NOT NULL,
          PRIMARY KEY (source_id, waypoint_id),
          INDEX idx_waypoints_source_expire (source_id, expire_at),
          INDEX idx_waypoints_source_owner  (source_id, owner_node_num),
          CONSTRAINT fk_waypoints_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        )
      `);
    } else {
      logger.debug('waypoints table already exists, skipping create');
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 053 complete (MySQL)');
}
