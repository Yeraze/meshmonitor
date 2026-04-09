/**
 * Migration 021: Add sourceId column to all data tables (Phase 2)
 *
 * Adds a nullable TEXT `sourceId` column to every data table so rows can be
 * associated with a specific source. NULL means "belongs to the legacy default
 * source" (assigned during startup by server.ts).
 *
 * Tables: nodes, messages, telemetry, traceroutes, channels,
 *         neighbor_info, packet_log, ignored_nodes, channel_database
 *
 * Indexes are created on nodes, messages, and telemetry for query efficiency.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const DATA_TABLES = [
  'nodes', 'messages', 'telemetry', 'traceroutes',
  'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 021 (SQLite): Adding sourceId column to data tables...');

    for (const table of DATA_TABLES) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN sourceId TEXT`);
        logger.debug(`Added sourceId to ${table}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${table}.sourceId already exists, skipping`);
        } else {
          logger.warn(`Could not add sourceId to ${table}:`, e.message);
        }
      }
    }

    // Indexes for most-queried tables
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes(sourceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages(sourceId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_source_id ON telemetry(sourceId)`);

    logger.info('Migration 021 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 021 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration021Postgres(client: any): Promise<void> {
  logger.info('Running migration 021 (PostgreSQL): Adding sourceId column to data tables...');

  for (const table of DATA_TABLES) {
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
    );
    logger.debug(`Ensured sourceId column on ${table}`);
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes("sourceId")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages("sourceId")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_telemetry_source_id ON telemetry("sourceId")`
  );

  logger.info('Migration 021 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration021Mysql(pool: any): Promise<void> {
  logger.info('Running migration 021 (MySQL): Adding sourceId column to data tables...');

  const conn = await pool.getConnection();
  try {
    for (const table of DATA_TABLES) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'sourceId'`,
        [table]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        // Use VARCHAR(36) for MySQL — UUIDs are always 36 chars and TEXT can't be indexed
        await conn.query(`ALTER TABLE ${table} ADD COLUMN sourceId VARCHAR(36)`);
        logger.debug(`Added sourceId to ${table}`);
      } else {
        logger.debug(`${table}.sourceId already exists, skipping`);
      }
    }

    // Indexes
    const indexChecks: Array<[string, string]> = [
      ['nodes', 'idx_nodes_source_id'],
      ['messages', 'idx_messages_source_id'],
      ['telemetry', 'idx_telemetry_source_id'],
    ];
    for (const [table, indexName] of indexChecks) {
      const [idxRows] = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName]
      );
      if (!(idxRows as any)[0]?.cnt) {
        await conn.query(`CREATE INDEX ${indexName} ON ${table}(sourceId)`);
        logger.debug(`Created index ${indexName}`);
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 021 complete (MySQL)');
}
