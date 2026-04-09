/**
 * Migration 024: Add sourceId to auto_traceroute_nodes and auto_traceroute_log
 *
 * Phase 2b of multi-source automation refactor. Makes the auto-traceroute
 * scheduler list and run history per-source.
 *
 * auto_traceroute_nodes:
 *   - add nullable sourceId column
 *   - drop existing UNIQUE(nodeNum) constraint
 *   - add composite UNIQUE(nodeNum, sourceId) — same node can be tracerouted
 *     from multiple sources.
 *
 * auto_traceroute_log:
 *   - add nullable sourceId column
 *
 * NULL sourceId = legacy/unscoped rows. Idempotent for all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 024 (SQLite): Adding sourceId to traceroute tables...');

    // --- auto_traceroute_log: simple ADD COLUMN
    try {
      db.exec(`ALTER TABLE auto_traceroute_log ADD COLUMN sourceId TEXT`);
      logger.debug('Added sourceId to auto_traceroute_log');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('auto_traceroute_log.sourceId already exists, skipping');
      } else {
        logger.warn('Could not add sourceId to auto_traceroute_log:', e.message);
      }
    }

    // --- auto_traceroute_nodes: needs table rebuild to change unique constraint
    // Check if sourceId column already exists (idempotency via PRAGMA).
    const cols = db.prepare(`PRAGMA table_info(auto_traceroute_nodes)`).all() as Array<{ name: string }>;
    const hasSourceId = cols.some((c) => c.name === 'sourceId');

    if (hasSourceId) {
      logger.debug('auto_traceroute_nodes.sourceId already exists, skipping rebuild');
    } else {
      logger.debug('Rebuilding auto_traceroute_nodes to add sourceId + composite unique');
      db.exec(`
        CREATE TABLE IF NOT EXISTS auto_traceroute_nodes_new (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum   INTEGER NOT NULL,
          enabled   INTEGER DEFAULT 1,
          createdAt INTEGER NOT NULL,
          sourceId  TEXT,
          UNIQUE(nodeNum, sourceId)
        )
      `);
      db.exec(`
        INSERT INTO auto_traceroute_nodes_new (id, nodeNum, enabled, createdAt, sourceId)
        SELECT id, nodeNum, enabled, createdAt, NULL FROM auto_traceroute_nodes
      `);
      db.exec(`DROP TABLE auto_traceroute_nodes`);
      db.exec(`ALTER TABLE auto_traceroute_nodes_new RENAME TO auto_traceroute_nodes`);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_auto_traceroute_nodes_source_id ON auto_traceroute_nodes(sourceId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_auto_traceroute_log_source_id ON auto_traceroute_log(sourceId)`);
    } catch (e: any) {
      logger.debug(`Could not create traceroute sourceId indexes: ${e.message}`);
    }

    logger.info('Migration 024 complete (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 024 down: Not implemented (column drops are destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration024Postgres(client: any): Promise<void> {
  logger.info('Running migration 024 (PostgreSQL): Adding sourceId to traceroute tables...');

  await client.query(
    `ALTER TABLE auto_traceroute_nodes ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );
  await client.query(
    `ALTER TABLE auto_traceroute_log ADD COLUMN IF NOT EXISTS "sourceId" TEXT`
  );

  // Drop the old unique on nodeNum if it exists, add composite unique.
  // PG's default unique constraint name from `.notNull().unique()` is
  // <table>_<col>_key (i.e. auto_traceroute_nodes_nodeNum_key).
  await client.query(
    `ALTER TABLE auto_traceroute_nodes DROP CONSTRAINT IF EXISTS "auto_traceroute_nodes_nodeNum_key"`
  );
  // Also try the unquoted variant just in case.
  await client.query(
    `ALTER TABLE auto_traceroute_nodes DROP CONSTRAINT IF EXISTS auto_traceroute_nodes_nodenum_key`
  );

  // Add composite unique constraint idempotently.
  const { rows } = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'auto_traceroute_nodes_nodenum_sourceid_uniq'`
  );
  if (!rows || rows.length === 0) {
    await client.query(
      `ALTER TABLE auto_traceroute_nodes
         ADD CONSTRAINT auto_traceroute_nodes_nodenum_sourceid_uniq UNIQUE ("nodeNum", "sourceId")`
    );
  }

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_auto_traceroute_nodes_source_id ON auto_traceroute_nodes("sourceId")`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_auto_traceroute_log_source_id ON auto_traceroute_log("sourceId")`
  );

  logger.info('Migration 024 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration024Mysql(pool: any): Promise<void> {
  logger.info('Running migration 024 (MySQL): Adding sourceId to traceroute tables...');

  const conn = await pool.getConnection();
  try {
    // auto_traceroute_nodes.sourceId
    const [nodeCol] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_traceroute_nodes' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(nodeCol) || nodeCol.length === 0) {
      await conn.query(`ALTER TABLE auto_traceroute_nodes ADD COLUMN sourceId VARCHAR(64)`);
      logger.debug('Added sourceId to auto_traceroute_nodes');
    }

    // auto_traceroute_log.sourceId
    const [logCol] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_traceroute_log' AND COLUMN_NAME = 'sourceId'`
    );
    if (!Array.isArray(logCol) || logCol.length === 0) {
      await conn.query(`ALTER TABLE auto_traceroute_log ADD COLUMN sourceId VARCHAR(64)`);
      logger.debug('Added sourceId to auto_traceroute_log');
    }

    // Drop old UNIQUE on nodeNum if present.
    // MySQL's default unique index name from Drizzle's .unique() is "nodeNum".
    const [uniqRows] = await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_traceroute_nodes'
         AND NON_UNIQUE = 0 AND INDEX_NAME != 'PRIMARY'`
    );
    const uniqIndexNames = new Set(((uniqRows as any[]) || []).map((r) => r.INDEX_NAME));
    // Try common names
    for (const name of ['nodeNum', 'auto_traceroute_nodes_nodeNum_unique', 'auto_traceroute_nodes_nodenum_unique']) {
      if (uniqIndexNames.has(name)) {
        try {
          await conn.query(`ALTER TABLE auto_traceroute_nodes DROP INDEX \`${name}\``);
          logger.debug(`Dropped old unique index ${name}`);
        } catch (e: any) {
          logger.debug(`Could not drop index ${name}: ${e.message}`);
        }
      }
    }

    // Add composite unique if missing.
    if (!uniqIndexNames.has('auto_traceroute_nodes_nodenum_sourceid_uniq')) {
      const [exists] = await conn.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_traceroute_nodes'
           AND INDEX_NAME = 'auto_traceroute_nodes_nodenum_sourceid_uniq'`
      );
      if (!Array.isArray(exists) || exists.length === 0) {
        await conn.query(
          `ALTER TABLE auto_traceroute_nodes
             ADD UNIQUE KEY auto_traceroute_nodes_nodenum_sourceid_uniq (nodeNum, sourceId)`
        );
      }
    }

    // Indexes
    const indexChecks: Array<[string, string]> = [
      ['auto_traceroute_nodes', 'idx_auto_traceroute_nodes_source_id'],
      ['auto_traceroute_log', 'idx_auto_traceroute_log_source_id'],
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

  logger.info('Migration 024 complete (MySQL)');
}
