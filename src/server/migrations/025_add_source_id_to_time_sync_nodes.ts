/**
 * Migration 025: Add sourceId to auto_time_sync_nodes
 *
 * Phase 2c of multi-source automation refactor. Makes the auto time-sync
 * scheduler list per-source.
 *
 * auto_time_sync_nodes:
 *   - add nullable sourceId column
 *   - drop existing UNIQUE(nodeNum) constraint
 *   - add composite UNIQUE(nodeNum, sourceId) — same node can be time-synced
 *     from multiple sources independently.
 *
 * NULL sourceId = legacy/unscoped rows. Idempotent for all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 025 (SQLite): Adding sourceId to auto_time_sync_nodes...');

    // auto_time_sync_nodes: needs table rebuild to change unique constraint.
    const cols = db.prepare(`PRAGMA table_info(auto_time_sync_nodes)`).all() as Array<{ name: string }>;
    const hasSourceId = cols.some((c) => c.name === 'sourceId');

    if (hasSourceId) {
      logger.debug('auto_time_sync_nodes.sourceId already exists, skipping rebuild');
    } else {
      logger.debug('Rebuilding auto_time_sync_nodes to add sourceId + composite unique');
      db.exec(`
        CREATE TABLE IF NOT EXISTS auto_time_sync_nodes_new (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum   INTEGER NOT NULL,
          enabled   INTEGER DEFAULT 1,
          createdAt INTEGER NOT NULL,
          sourceId  TEXT,
          UNIQUE(nodeNum, sourceId)
        )
      `);
      db.exec(`
        INSERT INTO auto_time_sync_nodes_new (id, nodeNum, enabled, createdAt, sourceId)
        SELECT id, nodeNum, enabled, createdAt, NULL FROM auto_time_sync_nodes
      `);
      db.exec(`DROP TABLE auto_time_sync_nodes`);
      db.exec(`ALTER TABLE auto_time_sync_nodes_new RENAME TO auto_time_sync_nodes`);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_auto_time_sync_nodes_source_id ON auto_time_sync_nodes(sourceId)`);
    } catch (e: any) {
      logger.debug(`Could not create auto_time_sync_nodes sourceId index: ${e.message}`);
    }

    logger.info('Migration 025 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 025 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration025Postgres(client: any): Promise<void> {
  logger.info('Running migration 025 (PostgreSQL): Adding sourceId to auto_time_sync_nodes...');

  await client.query(
    `ALTER TABLE auto_time_sync_nodes ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );

  // Drop the old unique on nodeNum if it exists. PG default constraint name
  // from `.notNull().unique()` is <table>_<col>_key.
  await client.query(
    `ALTER TABLE auto_time_sync_nodes DROP CONSTRAINT IF EXISTS "auto_time_sync_nodes_nodeNum_key"`
  );
  await client.query(
    `ALTER TABLE auto_time_sync_nodes DROP CONSTRAINT IF EXISTS auto_time_sync_nodes_nodenum_key`
  );

  // Add composite unique constraint idempotently.
  const { rows } = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'auto_time_sync_nodes_nodenum_sourceid_uniq'`
  );
  if (!rows || rows.length === 0) {
    await client.query(
      `ALTER TABLE auto_time_sync_nodes
         ADD CONSTRAINT auto_time_sync_nodes_nodenum_sourceid_uniq UNIQUE ("nodeNum", "sourceId")`
    );
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_auto_time_sync_nodes_source_id ON auto_time_sync_nodes("sourceId")`
  );

  logger.info('Migration 025 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration025Mysql(pool: any): Promise<void> {
  logger.info('Running migration 025 (MySQL): Adding sourceId to auto_time_sync_nodes...');

  const conn = await pool.getConnection();
  try {
    // auto_time_sync_nodes.sourceId
    const [nodeCol] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_time_sync_nodes' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(nodeCol) || nodeCol.length === 0) {
      await conn.query(`ALTER TABLE auto_time_sync_nodes ADD COLUMN sourceId VARCHAR(64)`);
      logger.debug('Added sourceId to auto_time_sync_nodes');
    }

    // Drop old UNIQUE on nodeNum if present.
    const [uniqRows] = await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_time_sync_nodes'
         AND NON_UNIQUE = 0 AND INDEX_NAME != 'PRIMARY'`
    );
    const uniqIndexNames = new Set(((uniqRows as any[]) || []).map((r) => r.INDEX_NAME));
    for (const name of ['nodeNum', 'auto_time_sync_nodes_nodeNum_unique', 'auto_time_sync_nodes_nodenum_unique']) {
      if (uniqIndexNames.has(name)) {
        try {
          await conn.query(`ALTER TABLE auto_time_sync_nodes DROP INDEX \`${name}\``);
          logger.debug(`Dropped old unique index ${name}`);
        } catch (e: any) {
          logger.debug(`Could not drop index ${name}: ${e.message}`);
        }
      }
    }

    // Add composite unique if missing.
    if (!uniqIndexNames.has('auto_time_sync_nodes_nodenum_sourceid_uniq')) {
      const [exists] = await conn.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_time_sync_nodes'
           AND INDEX_NAME = 'auto_time_sync_nodes_nodenum_sourceid_uniq'`
      );
      if (!Array.isArray(exists) || exists.length === 0) {
        await conn.query(
          `ALTER TABLE auto_time_sync_nodes
             ADD UNIQUE KEY auto_time_sync_nodes_nodenum_sourceid_uniq (nodeNum, sourceId)`
        );
      }
    }

    // Index
    const [idxRows] = await conn.query(
      `SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      ['auto_time_sync_nodes', 'idx_auto_time_sync_nodes_source_id']
    );
    if (!(idxRows as any)[0]?.cnt) {
      await conn.query(`CREATE INDEX idx_auto_time_sync_nodes_source_id ON auto_time_sync_nodes(sourceId)`);
      logger.debug('Created index idx_auto_time_sync_nodes_source_id');
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 025 complete (MySQL)');
}
