/**
 * Migration 048: Rebuild ignored_nodes as per-source.
 *
 * Previous design: `ignored_nodes` was a GLOBAL blocklist keyed on `nodeNum`
 * alone, with `sourceId` stored as informational-only. Mixing a global
 * persistence table with the per-source `nodes.isIgnored` flag produced
 * confusing cross-source behaviour (ignoring on source A didn't propagate to
 * source B's live flag; only eventual consistency via prune/restore).
 *
 * New design: `ignored_nodes` is now per-source, keyed on (nodeNum, sourceId)
 * composite PK, with `sourceId` as a foreign key to `sources(id)` ON DELETE
 * CASCADE. Each source has its own independent blocklist. The `nodes.isIgnored`
 * column on each per-source node row remains the live mirror.
 *
 * Backfill strategy (per user direction): drop the existing table entirely
 * and recreate the per-source blocklist from `nodes` where `isIgnored=1`.
 * This avoids any NULL-sourceId edge cases and uses the live flag as the
 * source of truth.
 *
 * The SQLite path drops + creates since the old table has no data worth
 * preserving independently of `nodes.isIgnored`. PG/MySQL follow the same
 * pattern.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

function now(): number {
  return Date.now();
}

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 048 (SQLite): Rebuilding ignored_nodes as per-source (nodeNum, sourceId)...');

    // Idempotency: if the table already has the composite PK shape, skip.
    try {
      const pkCols = db
        .prepare(`SELECT name FROM pragma_table_info('ignored_nodes') WHERE pk > 0 ORDER BY pk`)
        .all() as Array<{ name: string }>;
      const pkNames = pkCols.map(r => r.name);
      if (pkNames.includes('nodeNum') && pkNames.includes('sourceId')) {
        logger.debug('Migration 048 (SQLite): ignored_nodes already has composite PK, skipping');
        return;
      }
    } catch {
      // Table may not exist — proceed to create it.
    }

    const prevForeignKeys = (db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number }).foreign_keys;
    db.prepare(`PRAGMA foreign_keys=OFF`).run();

    const tx = db.transaction(() => {
      db.prepare(`DROP TABLE IF EXISTS ignored_nodes`).run();

      db.prepare(`
        CREATE TABLE ignored_nodes (
          nodeNum INTEGER NOT NULL,
          sourceId TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          longName TEXT,
          shortName TEXT,
          ignoredAt INTEGER NOT NULL,
          ignoredBy TEXT,
          PRIMARY KEY (nodeNum, sourceId),
          FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
        )
      `).run();

      const ts = now();
      db.prepare(`
        INSERT INTO ignored_nodes (nodeNum, sourceId, nodeId, longName, shortName, ignoredAt, ignoredBy)
        SELECT n.nodeNum, n.sourceId, n.nodeId, n.longName, n.shortName, ?, 'migration-048'
        FROM nodes n
        WHERE n.isIgnored = 1 AND n.sourceId IS NOT NULL
      `).run(ts);

      const count = (db.prepare(`SELECT COUNT(*) AS c FROM ignored_nodes`).get() as { c: number }).c;
      logger.info(`Migration 048 (SQLite): rebuilt ignored_nodes from nodes.isIgnored, ${count} row(s) backfilled`);
    });

    try {
      tx();
    } finally {
      if (prevForeignKeys) {
        db.prepare(`PRAGMA foreign_keys=ON`).run();
      }
    }
  },
};

export async function runMigration048Postgres(client: any): Promise<void> {
  logger.info('Running migration 048 (PostgreSQL): Rebuilding ignored_nodes as per-source (nodeNum, sourceId)...');

  // Idempotency: detect composite PK before dropping.
  const pkRows = await client.query(`
    SELECT a.attname
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'ignored_nodes'::regclass AND i.indisprimary
  `).catch(() => ({ rows: [] as Array<{ attname: string }> }));
  const pkNames = (pkRows.rows as Array<{ attname: string }>).map(r => r.attname);
  if (pkNames.includes('nodeNum') && pkNames.includes('sourceId')) {
    logger.debug('Migration 048 (PostgreSQL): ignored_nodes already has composite PK, skipping');
    return;
  }

  await client.query('BEGIN');
  try {
    await client.query(`DROP TABLE IF EXISTS "ignored_nodes"`);

    await client.query(`
      CREATE TABLE "ignored_nodes" (
        "nodeNum" BIGINT NOT NULL,
        "sourceId" TEXT NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
        "nodeId" TEXT NOT NULL,
        "longName" TEXT,
        "shortName" TEXT,
        "ignoredAt" BIGINT NOT NULL,
        "ignoredBy" TEXT,
        PRIMARY KEY ("nodeNum", "sourceId")
      )
    `);

    const ts = now();
    const backfill = await client.query(
      `INSERT INTO "ignored_nodes" ("nodeNum", "sourceId", "nodeId", "longName", "shortName", "ignoredAt", "ignoredBy")
       SELECT n."nodeNum", n."sourceId", n."nodeId", n."longName", n."shortName", $1, 'migration-048'
       FROM "nodes" n
       WHERE n."isIgnored" = true AND n."sourceId" IS NOT NULL`,
      [ts]
    );

    await client.query('COMMIT');
    logger.info(`Migration 048 (PostgreSQL): rebuilt ignored_nodes from nodes.isIgnored, ${backfill.rowCount ?? 0} row(s) backfilled`);
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Migration 048 (PostgreSQL) failed:', error);
    throw error;
  }
}

export async function runMigration048Mysql(pool: any): Promise<void> {
  logger.info('Running migration 048 (MySQL): Rebuilding ignored_nodes as per-source (nodeNum, sourceId)...');

  // Idempotency: detect composite PK before dropping.
  const [pkRows] = await pool.query(`
    SELECT COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ignored_nodes'
      AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY ORDINAL_POSITION
  `);
  const pkNames = (pkRows as Array<{ COLUMN_NAME: string }>).map(r => r.COLUMN_NAME);
  if (pkNames.includes('nodeNum') && pkNames.includes('sourceId')) {
    logger.debug('Migration 048 (MySQL): ignored_nodes already has composite PK, skipping');
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(`DROP TABLE IF EXISTS ignored_nodes`);

    await conn.query(`
      CREATE TABLE ignored_nodes (
        nodeNum BIGINT NOT NULL,
        sourceId VARCHAR(36) NOT NULL,
        nodeId VARCHAR(255) NOT NULL,
        longName VARCHAR(255),
        shortName VARCHAR(255),
        ignoredAt BIGINT NOT NULL,
        ignoredBy VARCHAR(255),
        PRIMARY KEY (nodeNum, sourceId),
        CONSTRAINT fk_ignored_nodes_source FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);

    const ts = now();
    const [result] = await conn.query(
      `INSERT INTO ignored_nodes (nodeNum, sourceId, nodeId, longName, shortName, ignoredAt, ignoredBy)
       SELECT n.nodeNum, n.sourceId, n.nodeId, n.longName, n.shortName, ?, 'migration-048'
       FROM nodes n
       WHERE n.isIgnored = 1 AND n.sourceId IS NOT NULL`,
      [ts]
    );

    await conn.commit();
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    logger.info(`Migration 048 (MySQL): rebuilt ignored_nodes from nodes.isIgnored, ${affected} row(s) backfilled`);
  } catch (error) {
    await conn.rollback();
    logger.error('Migration 048 (MySQL) failed:', error);
    throw error;
  } finally {
    conn.release();
  }
}
