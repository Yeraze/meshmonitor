/**
 * Migration 122: Clean up orphaned `nodes` rows left behind by a deleted source.
 *
 * Background (issue #4137): `DELETE /api/sources/:id` only ever removed the
 * `sources` row itself — it never cascaded to that source's `nodes` rows.
 * Those orphaned rows lived on forever with no UI path to clean them up
 * (there's no source left to target a per-source purge at), and since
 * `mergeNodesAcrossSources` groups purely by `nodeNum` with no check that a
 * row's `sourceId` still corresponds to a configured source, an orphan could
 * leak a stale `hideFromMap: true` (or any other flag) into the unified merge
 * permanently — the node could never be un-hidden from the unified/
 * cross-source views. `DELETE /api/sources/:id` now purges a source's node
 * rows at delete time going forward (see sourceRoutes.ts); this migration is
 * the one-shot sweep for rows orphaned by every *prior* source deletion.
 *
 * Scope: only the `nodes` table. Orphaned messages/telemetry/traceroutes/etc.
 * for a deleted source are a wider pre-existing issue, out of scope here —
 * purgeAllNodesAsync (used going forward) already cascades those for future
 * deletions, but backfilling the historical orphans in those tables is left
 * for a follow-up if it proves necessary.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL: once no `nodes.sourceId`
 * references a missing source, a re-run matches zero rows.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 122';

// SQLite / MySQL: bare identifiers (both dialects use camelCase `sourceId`
// unquoted for the `nodes` table, matching every other nodes.* migration).
const DELETE_SQL = `DELETE FROM nodes
  WHERE sourceId IS NOT NULL
    AND sourceId NOT IN (SELECT id FROM sources)`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): deleting orphaned node rows...`);
    const info = db.prepare(DELETE_SQL).run();
    if (info.changes > 0) {
      logger.info(`${LABEL} (SQLite): deleted ${info.changes} orphaned node row(s)`);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (the deleted orphan rows are unrecoverable)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg client is untyped in the migration runner (matches all sibling migrations)
export async function runMigration122Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): deleting orphaned node rows...`);
  const res = await client.query(
    `DELETE FROM nodes
     WHERE "sourceId" IS NOT NULL
       AND "sourceId" NOT IN (SELECT id FROM sources)`,
  );
  if (res?.rowCount) {
    logger.info(`${LABEL} (PostgreSQL): deleted ${res.rowCount} orphaned node row(s)`);
  }
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql pool is untyped in the migration runner (matches all sibling migrations)
export async function runMigration122Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): deleting orphaned node rows...`);
  const [res] = await pool.query(DELETE_SQL);
  const affected = (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`${LABEL} (MySQL): deleted ${affected} orphaned node row(s)`);
  }
}
