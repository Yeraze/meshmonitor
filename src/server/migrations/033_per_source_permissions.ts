/**
 * Migration 033: Per-source permissions expansion + unique index.
 *
 * Context:
 *   The `permissions` table gained a nullable `sourceId` column in migration 022.
 *   Until now, global grants (sourceId IS NULL) for "sourcey" resources (messages,
 *   nodes, channels, etc.) were checked with a source-agnostic lookup, meaning a
 *   single row covered all sources. Now that the permission system is fully
 *   per-source, we need:
 *
 *   1. For every existing global grant on a sourcey resource, copy it into one row
 *      per registered source.
 *   2. Delete the original global rows so they can't shadow per-source checks.
 *   3. Drop the old unique constraint on (user_id, resource) which prevents
 *      multiple per-source rows for the same user+resource.
 *   4. Create a new unique index on (user_id, resource, sourceId).
 *   5. Update channel_database rows with NULL sourceId to use the first source.
 *
 * Dialect notes:
 *   - SQLite column names: user_id, resource, can_view_on_map, can_read,
 *     can_write, can_delete, granted_at, granted_by, sourceId
 *   - PostgreSQL/MySQL column names: userId, resource, canViewOnMap, canRead,
 *     canWrite, canDelete, grantedAt, grantedBy, sourceId (PG needs double-quotes)
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const SOURCEY_RESOURCES = [
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute',
  'packetmonitor', 'configuration', 'connection', 'automation',
];

const NEW_INDEX_NAME = 'permissions_user_resource_source_uniq';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 033 (SQLite): per-source permissions expansion...');

    // Get all registered source IDs
    const sources = db.prepare(`SELECT id FROM sources`).all() as { id: string }[];
    logger.info(`Migration 033 (SQLite): found ${sources.length} source(s)`);

    // For each global sourcey row, insert a copy per source
    if (sources.length > 0) {
      const placeholders = SOURCEY_RESOURCES.map(() => '?').join(', ');
      const globalRows = db.prepare(`
        SELECT * FROM permissions
        WHERE sourceId IS NULL
          AND resource IN (${placeholders})
      `).all(...SOURCEY_RESOURCES) as any[];

      logger.info(`Migration 033 (SQLite): expanding ${globalRows.length} global sourcey grant(s) across ${sources.length} source(s)`);

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO permissions
          (user_id, resource, can_view_on_map, can_read, can_write, can_delete, granted_at, granted_by, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of globalRows) {
        for (const src of sources) {
          insertStmt.run(
            row.user_id,
            row.resource,
            row.can_view_on_map,
            row.can_read,
            row.can_write,
            row.can_delete,
            row.granted_at,
            row.granted_by,
            src.id,
          );
        }
      }
    }

    // Delete original global sourcey rows
    const placeholders2 = SOURCEY_RESOURCES.map(() => '?').join(', ');
    const delResult = db.prepare(`
      DELETE FROM permissions
      WHERE sourceId IS NULL
        AND resource IN (${placeholders2})
    `).run(...SOURCEY_RESOURCES);
    if (delResult.changes > 0) {
      logger.info(`Migration 033 (SQLite): deleted ${delResult.changes} global sourcey grant(s)`);
    }

    // Drop old unique index (try multiple possible names — SQLite may have used
    // any of these depending on how the table was originally created)
    const oldIndexNames = [
      'permissions_user_id_resource_unique',
      'sqlite_autoindex_permissions_1',
      'permissions_user_resource_unique',
    ];
    for (const idxName of oldIndexNames) {
      try {
        db.exec(`DROP INDEX IF EXISTS ${idxName}`);
        logger.debug(`Migration 033 (SQLite): dropped old index '${idxName}' (or it didn't exist)`);
      } catch {
        // Ignore — index didn't exist under this name
      }
    }

    // Create new unique index
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX_NAME}
        ON permissions(user_id, resource, sourceId)
    `);
    logger.info(`Migration 033 (SQLite): created unique index '${NEW_INDEX_NAME}'`);

    // Fix orphaned channel_database rows
    if (sources.length > 0) {
      const firstSource = sources[0].id;
      const cdResult = db.prepare(`
        UPDATE channel_database SET sourceId = ? WHERE sourceId IS NULL
      `).run(firstSource);
      if (cdResult.changes > 0) {
        logger.info(`Migration 033 (SQLite): migrated ${cdResult.changes} channel_database row(s) to source '${firstSource}'`);
      }
    }

    logger.info('Migration 033 complete (SQLite)');
  },

  down: (db: Database): void => {
    db.exec(`DROP INDEX IF EXISTS ${NEW_INDEX_NAME}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration033Postgres(client: any): Promise<void> {
  logger.info('Running migration 033 (PostgreSQL): per-source permissions expansion...');

  // Get all registered source IDs
  const sourcesRes = await client.query(`SELECT id FROM sources`);
  const sources: string[] = sourcesRes.rows.map((r: any) => r.id);
  logger.info(`Migration 033 (PostgreSQL): found ${sources.length} source(s)`);

  // For each source, copy global sourcey grants
  if (sources.length > 0) {
    for (const sourceId of sources) {
      await client.query(`
        INSERT INTO permissions
          ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
        SELECT "userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", $1
          FROM permissions
         WHERE "sourceId" IS NULL
           AND resource = ANY($2::text[])
        ON CONFLICT DO NOTHING
      `, [sourceId, SOURCEY_RESOURCES]);
    }
    logger.info(`Migration 033 (PostgreSQL): expanded global grants for ${sources.length} source(s)`);
  }

  // Delete original global sourcey rows
  const delRes = await client.query(`
    DELETE FROM permissions
     WHERE "sourceId" IS NULL
       AND resource = ANY($1::text[])
  `, [SOURCEY_RESOURCES]);
  if (delRes.rowCount && delRes.rowCount > 0) {
    logger.info(`Migration 033 (PostgreSQL): deleted ${delRes.rowCount} global sourcey grant(s)`);
  }

  // Drop old unique constraints/indexes (try multiple names)
  const oldIndexNames = [
    'permissions_user_id_resource_unique',
    'permissions_userId_resource_key',
    'permissions_user_resource_unique',
    'permissions_userId_resource_unique',
  ];
  for (const idxName of oldIndexNames) {
    await client.query(`DROP INDEX IF EXISTS "${idxName}"`);
    // Also try as a constraint
    try {
      await client.query(`ALTER TABLE permissions DROP CONSTRAINT IF EXISTS "${idxName}"`);
    } catch {
      // Not a constraint, ignore
    }
  }
  logger.info('Migration 033 (PostgreSQL): attempted drop of old unique index/constraint');

  // Create new unique index
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "${NEW_INDEX_NAME}"
      ON permissions("userId", resource, "sourceId")
  `);
  logger.info(`Migration 033 (PostgreSQL): created unique index '${NEW_INDEX_NAME}'`);

  // Fix orphaned channel_database rows
  if (sources.length > 0) {
    const firstSource = sources[0];
    const cdRes = await client.query(`
      UPDATE channel_database SET "sourceId" = $1 WHERE "sourceId" IS NULL
    `, [firstSource]);
    if (cdRes.rowCount && cdRes.rowCount > 0) {
      logger.info(`Migration 033 (PostgreSQL): migrated ${cdRes.rowCount} channel_database row(s) to source '${firstSource}'`);
    }
  }

  logger.info('Migration 033 complete (PostgreSQL)');
}

// ============ MySQL ============

export async function runMigration033Mysql(pool: any): Promise<void> {
  logger.info('Running migration 033 (MySQL): per-source permissions expansion...');

  const conn = await pool.getConnection();
  try {
    // Get all registered source IDs
    const [sourceRows] = await conn.query(`SELECT id FROM sources`);
    const sources: string[] = (sourceRows as any[]).map((r) => r.id);
    logger.info(`Migration 033 (MySQL): found ${sources.length} source(s)`);

    // For each source, copy global sourcey grants
    if (sources.length > 0) {
      const inPlaceholders = SOURCEY_RESOURCES.map(() => '?').join(', ');
      for (const sourceId of sources) {
        await conn.query(
          `INSERT IGNORE INTO permissions
             (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
           SELECT userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, ?
             FROM permissions
            WHERE sourceId IS NULL
              AND resource IN (${inPlaceholders})`,
          [sourceId, ...SOURCEY_RESOURCES],
        );
      }
      logger.info(`Migration 033 (MySQL): expanded global grants for ${sources.length} source(s)`);
    }

    // Delete original global sourcey rows
    const inPlaceholders2 = SOURCEY_RESOURCES.map(() => '?').join(', ');
    const [delResult] = await conn.query(
      `DELETE FROM permissions WHERE sourceId IS NULL AND resource IN (${inPlaceholders2})`,
      SOURCEY_RESOURCES,
    );
    const affected = (delResult as any)?.affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`Migration 033 (MySQL): deleted ${affected} global sourcey grant(s)`);
    }

    // Drop old unique indexes found via information_schema
    const oldIndexNames = [
      'permissions_user_id_resource_unique',
      'permissions_userId_resource_key',
      'permissions_user_resource_unique',
      'permissions_userId_resource_unique',
    ];
    for (const idxName of oldIndexNames) {
      const [existRows] = await conn.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'permissions'
            AND INDEX_NAME = ?`,
        [idxName],
      );
      if ((existRows as any[]).length > 0) {
        await conn.query(`DROP INDEX \`${idxName}\` ON permissions`);
        logger.info(`Migration 033 (MySQL): dropped old index '${idxName}'`);
      }
    }

    // Create new unique index (guard via information_schema)
    const [existNewIdx] = await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'permissions'
          AND INDEX_NAME = ?`,
      [NEW_INDEX_NAME],
    );
    if ((existNewIdx as any[]).length === 0) {
      await conn.query(
        `CREATE UNIQUE INDEX \`${NEW_INDEX_NAME}\` ON permissions(userId, resource, sourceId)`,
      );
      logger.info(`Migration 033 (MySQL): created unique index '${NEW_INDEX_NAME}'`);
    } else {
      logger.debug(`Migration 033 (MySQL): unique index '${NEW_INDEX_NAME}' already exists`);
    }

    // Fix orphaned channel_database rows
    if (sources.length > 0) {
      const firstSource = sources[0];
      const [cdResult] = await conn.query(
        `UPDATE channel_database SET sourceId = ? WHERE sourceId IS NULL`,
        [firstSource],
      );
      const cdAffected = (cdResult as any)?.affectedRows ?? 0;
      if (cdAffected > 0) {
        logger.info(`Migration 033 (MySQL): migrated ${cdAffected} channel_database row(s) to source '${firstSource}'`);
      }
    }
  } finally {
    conn.release();
  }

  logger.info('Migration 033 complete (MySQL)');
}
