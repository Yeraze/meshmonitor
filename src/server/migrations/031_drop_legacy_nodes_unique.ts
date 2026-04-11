/**
 * Migration 031: Drop legacy standalone UNIQUE on nodes.nodeId
 *
 * Migration 029 rebuilt the nodes table with a composite (nodeNum, sourceId)
 * PK and intended to drop the pre-refactor UNIQUE("nodeId") constraint as
 * part of the same rebuild. The Postgres path located the old constraint by
 * matching its definition text with the ILIKE pattern `%(nodeId)%`. The
 * actual constraint def is `UNIQUE ("nodeId")` — the column name is quoted,
 * so the substring `(nodeId)` is never present and the lookup silently
 * returned zero rows. The drop was skipped and upgraded Postgres databases
 * kept the old standalone unique alongside the new composite unique.
 *
 * Symptom: every cross-source node upsert (e.g. Sandbox2 receiving a node
 * already known to Default) throws error 23505 on `nodes_nodeId_key`, which
 * aborts `processIncomingData` before the message insert can run — so a
 * second source appears to receive almost no nodes and no messages.
 *
 * This migration drops any remaining standalone UNIQUE or UNIQUE INDEX on
 * `nodes.nodeId` alone. It is a no-op when the constraint is already gone.
 *
 * - SQLite: 029's table rebuild removed the old constraint (it was never in
 *   the CREATE TABLE for `nodes_new`), so this is unconditionally a no-op.
 * - MySQL: 029 enumerated UNIQUE indexes via information_schema and dropped
 *   any index whose columns were exactly `nodeId`. No-op in the common case,
 *   but kept as a defensive re-run.
 * - PostgreSQL: drops every UNIQUE constraint/index on `nodes` whose column
 *   list is exactly `nodeId`.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    // No-op: migration 029 rebuilt the nodes table without this constraint.
    logger.debug('Migration 031 (SQLite): no-op, legacy unique already dropped by 029');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 031 down: not implemented (destructive)');
  },
};

// ============ PostgreSQL ============

export async function runMigration031Postgres(client: any): Promise<void> {
  logger.info('Running migration 031 (PostgreSQL): dropping legacy standalone UNIQUE on nodes.nodeId...');

  // Find every UNIQUE constraint on `nodes` whose column list is exactly
  // `nodeId`. We join through pg_constraint → pg_attribute to get the column
  // names directly rather than parsing the text of pg_get_constraintdef (which
  // was what 029 tried to do — with the quoting bug that made it miss).
  const uniqRows = await client.query(`
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'nodes'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY a.attnum)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['nodeId']::name[]
  `);

  for (const row of uniqRows.rows) {
    logger.info(`Migration 031 (PostgreSQL): dropping legacy unique constraint '${row.conname}'`);
    await client.query(`ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "${row.conname}"`);
  }

  // Also drop any UNIQUE INDEX (not backing a constraint) whose key is exactly
  // `nodeId`. In practice the constraint drop above also removes its index,
  // but a standalone unique index could have been created by an earlier tool.
  const idxRows = await client.query(`
    SELECT i.relname AS indexname
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE t.relname = 'nodes'
      AND ix.indisunique
      AND NOT ix.indisprimary
      AND (
        SELECT array_agg(a.attname ORDER BY a.attnum)
        FROM unnest(ix.indkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      ) = ARRAY['nodeId']::name[]
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid
      )
  `);

  for (const row of idxRows.rows) {
    logger.info(`Migration 031 (PostgreSQL): dropping legacy unique index '${row.indexname}'`);
    await client.query(`DROP INDEX IF EXISTS "${row.indexname}"`);
  }

  // Verification: re-run the same discovery queries and confirm nothing
  // survived the drops. If anything remains we log an error so operators see
  // the failure in logs (we do NOT throw — the app still starts, since the
  // degraded state is the pre-031 behavior the migration is trying to fix).
  const verifyConstraints = await client.query(`
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'nodes'::regclass
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY a.attnum)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['nodeId']::name[]
  `);
  const verifyIndexes = await client.query(`
    SELECT i.relname AS indexname
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    WHERE t.relname = 'nodes'
      AND ix.indisunique
      AND NOT ix.indisprimary
      AND (
        SELECT array_agg(a.attname ORDER BY a.attnum)
        FROM unnest(ix.indkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      ) = ARRAY['nodeId']::name[]
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid
      )
  `);

  if (verifyConstraints.rows.length > 0 || verifyIndexes.rows.length > 0) {
    logger.error(
      'Migration 031 verification FAILED: legacy unique on nodes.nodeId still present. ' +
      `constraints=${JSON.stringify(verifyConstraints.rows)} ` +
      `indexes=${JSON.stringify(verifyIndexes.rows)}`
    );
  } else {
    logger.info('Migration 031 (PostgreSQL): verified no legacy unique on nodes.nodeId remains');
  }

  logger.info('Migration 031 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration031Mysql(pool: any): Promise<void> {
  logger.info('Running migration 031 (MySQL): dropping legacy standalone UNIQUE on nodes.nodeId...');

  const conn = await pool.getConnection();
  try {
    const [uniqRows] = await conn.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'nodes'
         AND NON_UNIQUE = 0
       GROUP BY INDEX_NAME`
    );

    for (const row of uniqRows as any[]) {
      if (row.INDEX_NAME === 'PRIMARY') continue;
      if (row.cols === 'nodeId') {
        logger.info(`Migration 031 (MySQL): dropping legacy unique index '${row.INDEX_NAME}'`);
        await conn.query(`ALTER TABLE nodes DROP INDEX \`${row.INDEX_NAME}\``);
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 031 complete (MySQL)');
}
