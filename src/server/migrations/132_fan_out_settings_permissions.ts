/**
 * Migration 132: fan out `settings` permission grants across every source
 * (#4416, PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md §3).
 *
 * Context: WP1 added `'settings'` to `SOURCEY_RESOURCES` in
 * `src/types/permission.ts`. Before that change `checkPermissionAsync`
 * treated `settings` as a global (non-sourcey) resource, so a single
 * `sourceId IS NULL` grant authorized every source and the unscoped
 * endpoints. After that change the sourcey branch requires an exact
 * `sourceId` match (or a per-source union when unscoped), so every existing
 * `sourceId IS NULL` settings row is instantly inert — every non-admin user
 * who held `settings:write`/`read` loses it silently, everywhere, with no
 * error message anywhere in the product. This migration is what prevents
 * that: it converts each user's existing EFFECTIVE settings access into an
 * equivalent per-source row on every source that exists right now, then
 * removes the now-inert global rows.
 *
 * "Effective" is deliberately read from ALL of a user's settings rows, not
 * only the NULL-scoped ones. The pre-flip `checkPermissionAsync` non-sourcey
 * branch never short-circuited on scope — it OR'd across every row the user
 * had for the resource, NULL or per-source (services/database.ts:4392+,
 * pre-#4416; that comment names exactly this shape: "covers databases where
 * the admin PUT endpoint historically saved global grants under a
 * sourceId"). A user whose ONLY settings row is scoped to source A therefore
 * has write on every source and on the global endpoint TODAY. Fanning out
 * only the NULL rows would leave that user with write on source A alone —
 * a silent revocation this migration exists to prevent. Reading every row
 * and OR-ing them is a strict superset of "fan out the NULL rows": for a
 * user whose only row is the common NULL-scoped one, ORing a single row
 * with itself changes nothing. See PHASE6 spec §3.2 (approved by the
 * orchestrator) for the full justification.
 *
 * Ordering is load-bearing: insert/widen first, delete the NULL rows last,
 * all in one transaction. A crash between steps leaves the NULL rows intact
 * and the migration re-runnable — never delete first (see #4233, the
 * migration-030 incident this pattern exists to avoid; also 131's structural
 * template).
 *
 * Zero sources at migration time is handled by NOT deleting: see
 * `computeFanOutInserts`'s caller below and the WARN log line. WP7
 * (`sourceRoutes.ts`, out of scope for this file) reconciles that case the
 * moment a source is created, by calling the same shared fan-out functions.
 */
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';
import { computeEffectiveGrants, computeFanOutInserts, pairKey, type RawGrantRow, type EffectiveGrant } from '../services/settingsGrantFanout.js';

const LABEL = 'Migration 132';

/**
 * Frozen at migration-authoring time. Do NOT replace with an import of
 * SOURCEY_RESOURCES from src/types/permission.ts — a migration is a
 * statement about a point in time, and on a fresh install migrations replay
 * from scratch (#3962), so an imported array would run against whatever it
 * contains today, not what it contained when 132 shipped. This is the exact
 * bug Phase 5 fixed in migration 050, and the reason migration 131 froze its
 * ten keys locally.
 */
const FANNED_OUT_RESOURCES = ['settings'] as const;
const RESOURCE = FANNED_OUT_RESOURCES[0];

/** Rows per multi-row INSERT (PostgreSQL/MySQL). 200 rows x 9 bound params =
 * 1800 placeholders, comfortably inside PostgreSQL's 65535 limit and MySQL's
 * default max_allowed_packet. Copied in rather than imported — migrations
 * deliberately do not import from each other (see 131). */
const SEED_BATCH_SIZE = 200;

/** Split an array into fixed-size chunks. Copied from 131's `chunk<T>()`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** The 8 possible boolean-flag combinations of an EffectiveGrant, used to
 * group the widen-UPDATE in step 5b into at most 8 statements instead of one
 * per user. */
function flagCombo(g: EffectiveGrant): string {
  return `${g.canViewOnMap ? 1 : 0}${g.canRead ? 1 : 0}${g.canWrite ? 1 : 0}${g.canDelete ? 1 : 0}`;
}

function groupByFlagCombo(grants: EffectiveGrant[]): Map<string, { flags: EffectiveGrant; userIds: number[] }> {
  const groups = new Map<string, { flags: EffectiveGrant; userIds: number[] }>();
  for (const g of grants) {
    const key = flagCombo(g);
    let group = groups.get(key);
    if (!group) {
      group = { flags: g, userIds: [] };
      groups.set(key, group);
    }
    group.userIds.push(g.userId);
  }
  return groups;
}

// ============ SQLite ============

interface SqlitePermissionRow {
  id: number;
  user_id: number;
  resource: string;
  can_view_on_map: number;
  can_read: number;
  can_write: number;
  granted_at: number | null;
  granted_by: number | null;
  sourceId: string | null;
}

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): fanning out settings permission grants...`);

    let sourceIds: string[];
    try {
      sourceIds = (db.prepare(`SELECT id FROM sources`).all() as Array<{ id: string }>).map((r) => r.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`${LABEL} (SQLite): sources table not present, skipping (${msg})`);
      return;
    }

    let rawRows: SqlitePermissionRow[];
    try {
      rawRows = db.prepare(
        `SELECT * FROM permissions WHERE resource = ?`
      ).all(RESOURCE) as SqlitePermissionRow[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`${LABEL} (SQLite): permissions table not present, skipping (${msg})`);
      return;
    }

    if (rawRows.length === 0) {
      logger.debug(`${LABEL} (SQLite): no settings permission rows, nothing to do`);
      return;
    }

    if (sourceIds.length === 0) {
      logger.warn(
        `${LABEL} (SQLite): no sources present — settings grants left global and INERT. ` +
        `Users with settings grants will be denied until an admin re-grants per source after adding a source.`
      );
      return;
    }

    const rows: RawGrantRow[] = rawRows.map((r) => ({
      userId: r.user_id,
      sourceId: r.sourceId,
      canViewOnMap: !!r.can_view_on_map,
      canRead: !!r.can_read,
      canWrite: !!r.can_write,
      grantedAt: r.granted_at,
      grantedBy: r.granted_by,
    }));

    const now = Date.now();
    const effective = computeEffectiveGrants(rows, now);
    logger.info(`${LABEL} (SQLite): ${effective.length} user(s) have effective settings access out of ${new Set(rows.map((r) => r.userId)).size} with a settings row`);

    const existingPairs = new Set<string>();
    for (const r of rawRows) {
      if (r.sourceId !== null) existingPairs.add(pairKey(r.user_id, r.sourceId));
    }

    const inserts = computeFanOutInserts(effective, sourceIds, existingPairs);
    const groups = groupByFlagCombo(effective);

    const insertStmt = db.prepare(`
      INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by, sourceId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = db.prepare(`
      UPDATE permissions
         SET can_view_on_map = ?, can_read = ?, can_write = ?
       WHERE resource = ? AND sourceId IS NOT NULL AND user_id = ?
    `);
    const deleteStmt = db.prepare(`
      DELETE FROM permissions WHERE resource = ? AND sourceId IS NULL
    `);

    const tx = db.transaction(() => {
      for (const batch of chunk(inserts, SEED_BATCH_SIZE)) {
        for (const ins of batch) {
          insertStmt.run(
            ins.userId, RESOURCE,
            ins.canViewOnMap ? 1 : 0, ins.canRead ? 1 : 0, ins.canWrite ? 1 : 0,
            ins.grantedAt, ins.grantedBy, ins.sourceId,
          );
        }
      }
      for (const group of groups.values()) {
        for (const userId of group.userIds) {
          updateStmt.run(
            group.flags.canViewOnMap ? 1 : 0, group.flags.canRead ? 1 : 0, group.flags.canWrite ? 1 : 0,
            RESOURCE, userId,
          );
        }
      }
      deleteStmt.run(RESOURCE);
    });
    tx();

    logger.info(`${LABEL} (SQLite): wrote up to ${inserts.length} row(s) for ${sourceIds.length} source(s), removed global settings rows`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (fanned-out rows are harmless to leave in place)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration132Postgres(client: PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): fanning out settings permission grants...`);

  let sourceIds: string[];
  try {
    const { rows } = await client.query(`SELECT id FROM sources`);
    sourceIds = (rows as Array<{ id: string }>).map((r) => r.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`${LABEL} (PostgreSQL): sources table not present, skipping (${msg})`);
    return;
  }

  let rawRows: Array<{
    userId: number; sourceId: string | null;
    canViewOnMap: boolean; canRead: boolean; canWrite: boolean; canDelete: boolean;
    grantedAt: number | null; grantedBy: number | null;
  }>;
  try {
    const { rows } = await client.query(
      `SELECT "userId", "sourceId", "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy"
         FROM permissions WHERE resource = $1`,
      [RESOURCE],
    );
    rawRows = rows;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`${LABEL} (PostgreSQL): permissions table not present, skipping (${msg})`);
    return;
  }

  if (rawRows.length === 0) {
    logger.debug(`${LABEL} (PostgreSQL): no settings permission rows, nothing to do`);
    return;
  }

  if (sourceIds.length === 0) {
    logger.warn(
      `${LABEL} (PostgreSQL): no sources present — settings grants left global and INERT. ` +
      `Users with settings grants will be denied until an admin re-grants per source after adding a source.`
    );
    return;
  }

  const rows: RawGrantRow[] = rawRows.map((r) => ({
    userId: r.userId,
    sourceId: r.sourceId,
    canViewOnMap: !!r.canViewOnMap,
    canRead: !!r.canRead,
    canWrite: !!r.canWrite,
    canDelete: !!r.canDelete,
    grantedAt: r.grantedAt,
    grantedBy: r.grantedBy,
  }));

  const now = Date.now();
  const effective = computeEffectiveGrants(rows, now);
  logger.info(`${LABEL} (PostgreSQL): ${effective.length} user(s) have effective settings access out of ${new Set(rows.map((r) => r.userId)).size} with a settings row`);

  const existingPairs = new Set<string>();
  for (const r of rawRows) {
    if (r.sourceId !== null) existingPairs.add(pairKey(r.userId, r.sourceId));
  }

  const inserts = computeFanOutInserts(effective, sourceIds, existingPairs);
  const groups = groupByFlagCombo(effective);

  await client.query('BEGIN');
  try {
    for (const batch of chunk(inserts, SEED_BATCH_SIZE)) {
      const values: unknown[] = [];
      const tuples = batch.map((ins, i) => {
        const b = i * 9;
        values.push(ins.userId, RESOURCE, ins.canViewOnMap, ins.canRead, ins.canWrite, ins.canDelete, ins.grantedAt, ins.grantedBy, ins.sourceId);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
      });
      await client.query(
        `INSERT INTO permissions ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
         VALUES ${tuples.join(', ')}
         ON CONFLICT DO NOTHING`,
        values,
      );
    }

    for (const group of groups.values()) {
      if (group.userIds.length === 0) continue;
      const placeholders = group.userIds.map((_, i) => `$${i + 6}`).join(', ');
      await client.query(
        `UPDATE permissions
            SET "canViewOnMap" = $1, "canRead" = $2, "canWrite" = $3, "canDelete" = $4
          WHERE resource = $5 AND "sourceId" IS NOT NULL AND "userId" IN (${placeholders})`,
        [group.flags.canViewOnMap, group.flags.canRead, group.flags.canWrite, group.flags.canDelete, RESOURCE, ...group.userIds],
      );
    }

    await client.query(`DELETE FROM permissions WHERE resource = $1 AND "sourceId" IS NULL`, [RESOURCE]);

    await client.query('COMMIT');
    logger.info(`${LABEL} (PostgreSQL): wrote up to ${inserts.length} row(s) for ${sourceIds.length} source(s), removed global settings rows`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ============ MySQL ============

export async function runMigration132Mysql(pool: MySQLPool): Promise<void> {
  logger.info(`${LABEL} (MySQL): fanning out settings permission grants...`);
  const conn = await pool.getConnection();
  try {
    let sourceIds: string[];
    try {
      const [rows] = await conn.query(`SELECT id FROM sources`);
      sourceIds = (rows as Array<{ id: string }>).map((r) => r.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`${LABEL} (MySQL): sources table not present, skipping (${msg})`);
      return;
    }

    let rawRows: Array<{
      userId: number; sourceId: string | null;
      canViewOnMap: number | boolean; canRead: number | boolean; canWrite: number | boolean; canDelete: number | boolean;
      grantedAt: number | null; grantedBy: number | null;
    }>;
    try {
      const [rows] = await conn.query(
        `SELECT userId, sourceId, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy
           FROM permissions WHERE resource = ?`,
        [RESOURCE],
      );
      rawRows = rows as typeof rawRows;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`${LABEL} (MySQL): permissions table not present, skipping (${msg})`);
      return;
    }

    if (rawRows.length === 0) {
      logger.debug(`${LABEL} (MySQL): no settings permission rows, nothing to do`);
      return;
    }

    if (sourceIds.length === 0) {
      logger.warn(
        `${LABEL} (MySQL): no sources present — settings grants left global and INERT. ` +
        `Users with settings grants will be denied until an admin re-grants per source after adding a source.`
      );
      return;
    }

    const rows: RawGrantRow[] = rawRows.map((r) => ({
      userId: r.userId,
      sourceId: r.sourceId,
      canViewOnMap: !!r.canViewOnMap,
      canRead: !!r.canRead,
      canWrite: !!r.canWrite,
      canDelete: !!r.canDelete,
      grantedAt: r.grantedAt,
      grantedBy: r.grantedBy,
    }));

    const now = Date.now();
    const effective = computeEffectiveGrants(rows, now);
    logger.info(`${LABEL} (MySQL): ${effective.length} user(s) have effective settings access out of ${new Set(rows.map((r) => r.userId)).size} with a settings row`);

    const existingPairs = new Set<string>();
    for (const r of rawRows) {
      if (r.sourceId !== null) existingPairs.add(pairKey(r.userId, r.sourceId));
    }

    const inserts = computeFanOutInserts(effective, sourceIds, existingPairs);
    const groups = groupByFlagCombo(effective);

    await conn.beginTransaction();
    try {
      const INSERT_PREFIX = 'INSERT IGNORE INTO permissions (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId) VALUES ';
      const ROW_TUPLE = '(?, ?, ?, ?, ?, ?, ?, ?, ?)';
      for (const batch of chunk(inserts, SEED_BATCH_SIZE)) {
        await conn.query(
          INSERT_PREFIX + batch.map(() => ROW_TUPLE).join(', '),
          batch.flatMap((ins) => [ins.userId, RESOURCE, ins.canViewOnMap, ins.canRead, ins.canWrite, ins.canDelete, ins.grantedAt, ins.grantedBy, ins.sourceId]),
        );
      }

      for (const group of groups.values()) {
        if (group.userIds.length === 0) continue;
        const placeholders = group.userIds.map(() => '?').join(', ');
        await conn.query(
          `UPDATE permissions
              SET canViewOnMap = ?, canRead = ?, canWrite = ?, canDelete = ?
            WHERE resource = ? AND sourceId IS NOT NULL AND userId IN (${placeholders})`,
          [group.flags.canViewOnMap, group.flags.canRead, group.flags.canWrite, group.flags.canDelete, RESOURCE, ...group.userIds],
        );
      }

      await conn.query(`DELETE FROM permissions WHERE resource = ? AND sourceId IS NULL`, [RESOURCE]);

      await conn.commit();
      logger.info(`${LABEL} (MySQL): wrote up to ${inserts.length} row(s) for ${sourceIds.length} source(s), removed global settings rows`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
}
