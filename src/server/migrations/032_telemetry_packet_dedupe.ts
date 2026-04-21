/**
 * Migration 032: Telemetry packet dedupe via soft unique constraint.
 *
 * Context (issue #2629):
 *   The same Meshtastic packet can arrive multiple times when mesh routers
 *   re-broadcast it, producing duplicate telemetry rows — one per arrival,
 *   per metric — all sharing the same packetId. A single telemetry packet
 *   also legitimately produces multiple rows (one per metric type), so the
 *   uniqueness key must include telemetryType.
 *
 *   This migration adds a DB-level backstop: a unique index on
 *     (sourceId, nodeNum, packetId, telemetryType)
 *   scoped to rows where packetId IS NOT NULL, so that any duplicate packet
 *   insertion becomes a silent no-op (via insertIgnore) regardless of what
 *   code path produced it. Rows with NULL packetId (legacy / synthesized
 *   telemetry) still insert freely.
 *
 *   The migration first dedupes any existing duplicate rows, keeping the
 *   lowest id per key tuple, then creates the index.
 *
 * Dialect notes:
 *   - SQLite and PostgreSQL support partial unique indexes (WHERE clause).
 *   - MySQL does NOT support partial unique indexes, so we create a plain
 *     unique index. MySQL's UNIQUE index permits multiple rows with NULL
 *     values in any indexed column (per SQL standard), so legacy rows with
 *     NULL packetId still coexist — the constraint only bites when all four
 *     columns are non-NULL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const INDEX_NAME = 'telemetry_source_packet_type_uniq';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 032 (SQLite): telemetry packet dedupe...');

    // Legacy v3.x databases carry `telemetry.nodeNum REFERENCES nodes(nodeNum)`.
    // Migration 029 rebuilt nodes with composite PK (nodeNum, sourceId), which
    // makes that FK structurally invalid (parent column no longer unique).
    // With foreign_keys=ON any DELETE on telemetry then raises
    // "foreign key mismatch - telemetry referencing nodes". Disable FK
    // enforcement for this migration and restore it in finally. See 029/030
    // for the same pattern.
    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) {
      db.pragma('foreign_keys = OFF');
    }

    try {
      // Dedupe existing rows: keep lowest id per (sourceId, nodeNum, packetId, telemetryType)
      // where packetId IS NOT NULL. NULL packetId rows are left alone.
      const deleteStmt = db.prepare(`
        DELETE FROM telemetry
        WHERE packetId IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM telemetry
            WHERE packetId IS NOT NULL
            GROUP BY sourceId, nodeNum, packetId, telemetryType
          )
      `);
      const result = deleteStmt.run();
      if (result.changes > 0) {
        logger.info(`Migration 032 (SQLite): deduped ${result.changes} duplicate telemetry rows`);
      }

      // Partial unique index (idempotent via IF NOT EXISTS)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
          ON telemetry(sourceId, nodeNum, packetId, telemetryType)
          WHERE packetId IS NOT NULL
      `);
    } finally {
      if (prevForeignKeys) {
        db.pragma('foreign_keys = ON');
      }
    }

    logger.info('Migration 032 complete (SQLite)');
  },

  down: (db: Database): void => {
    db.exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration032Postgres(client: any): Promise<void> {
  logger.info('Running migration 032 (PostgreSQL): telemetry packet dedupe...');

  // Dedupe: self-join delete keeping lowest id.
  // IS NOT DISTINCT FROM handles the (unlikely) sourceId-NULL case symmetrically.
  const deleteResult = await client.query(`
    DELETE FROM telemetry a
    USING telemetry b
    WHERE a.id > b.id
      AND a."packetId" IS NOT NULL
      AND b."packetId" IS NOT NULL
      AND a."sourceId" IS NOT DISTINCT FROM b."sourceId"
      AND a."nodeNum" = b."nodeNum"
      AND a."packetId" = b."packetId"
      AND a."telemetryType" = b."telemetryType"
  `);
  if (deleteResult.rowCount && deleteResult.rowCount > 0) {
    logger.info(`Migration 032 (PostgreSQL): deduped ${deleteResult.rowCount} duplicate telemetry rows`);
  }

  // Partial unique index (idempotent via IF NOT EXISTS)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
      ON telemetry("sourceId", "nodeNum", "packetId", "telemetryType")
      WHERE "packetId" IS NOT NULL
  `);

  logger.info('Migration 032 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration032Mysql(pool: any): Promise<void> {
  logger.info('Running migration 032 (MySQL): telemetry packet dedupe...');

  const conn = await pool.getConnection();
  try {
    // Dedupe existing rows: self-join delete keeping lowest id.
    // For MySQL we need to handle sourceId NULL equivalence manually.
    const [deleteResult] = await conn.query(`
      DELETE t1 FROM telemetry t1
      INNER JOIN telemetry t2
        ON t1.id > t2.id
       AND t1.packetId IS NOT NULL
       AND t2.packetId IS NOT NULL
       AND ((t1.sourceId = t2.sourceId) OR (t1.sourceId IS NULL AND t2.sourceId IS NULL))
       AND t1.nodeNum = t2.nodeNum
       AND t1.packetId = t2.packetId
       AND t1.telemetryType = t2.telemetryType
    `);
    const affected = (deleteResult as any)?.affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`Migration 032 (MySQL): deduped ${affected} duplicate telemetry rows`);
    }

    // MySQL does not support partial unique indexes — create a plain unique
    // index. MySQL's UNIQUE permits multiple rows with NULL in indexed
    // columns (SQL standard), so legacy NULL-packetId rows still coexist.
    // Idempotency: guard via information_schema lookup.
    const [existingIdxRows] = await conn.query(
      `SELECT INDEX_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'telemetry'
          AND INDEX_NAME = ?`,
      [INDEX_NAME]
    );
    if ((existingIdxRows as any[]).length === 0) {
      await conn.query(
        `CREATE UNIQUE INDEX \`${INDEX_NAME}\`
           ON telemetry(sourceId, nodeNum, packetId, telemetryType)`
      );
      logger.info(`Migration 032 (MySQL): created unique index '${INDEX_NAME}'`);
    } else {
      logger.debug(`Migration 032 (MySQL): unique index '${INDEX_NAME}' already exists`);
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 032 complete (MySQL)');
}
