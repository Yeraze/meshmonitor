/**
 * Migration 050: Promote legacy global per-source settings (and orphan
 * NULL-sourceId rows in auto_traceroute_nodes / auto_time_sync_nodes) to the
 * default source's namespace.
 *
 * Background: Pre-4.x MeshMonitor stored automation, scheduler, and other
 * runtime settings under un-namespaced keys (e.g. `autoResponderEnabled`).
 * 4.x introduced per-source settings via the `source:{id}:{key}` prefix.
 * `getSettingForSource` previously fell back to the global key when no
 * per-source override existed, which produced a cluster of bugs:
 *
 *   - #2839: secondary sources inherited the main source's automation
 *     config and fired duplicate responses.
 *   - #2840: auto-traceroute UI showed empty after upgrade because the
 *     "Specific Nodes" list lived on `auto_traceroute_nodes` rows whose
 *     `sourceId` was NULL (pre-multi-source vintage), but the read filtered
 *     by the default source's id.
 *   - "Notifications need uncheck/recheck after upgrade": settings reads
 *     fell back to global, so the runtime kept working off the legacy
 *     value while the UI (querying per-source state) showed defaults.
 *
 * Together with the helper change in `src/db/repositories/settings.ts`
 * removing the global fallback, this migration makes upgraded single-source
 * installs land in a state where the default source owns all the user's
 * existing config and secondary sources start clean.
 *
 * Idempotency: registry's `settingsKey` blocks re-runs at the harness
 * level. The internal SQL also uses INSERT ... ON CONFLICT DO NOTHING /
 * INSERT IGNORE so a manual re-run wouldn't clobber existing per-source
 * overrides.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { PER_SOURCE_SETTINGS_KEYS } from '../constants/settings.js';
import {
  ensureDefaultSourceIdSqlite,
  ensureDefaultSourceIdPostgres,
  ensureDefaultSourceIdMysql,
} from './_legacyDefaultSource.js';

const LABEL = 'Migration 050';

function now(): number {
  return Date.now();
}

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): promoting legacy global settings to default source`);

    const defaultSourceId = ensureDefaultSourceIdSqlite(db, LABEL);
    if (!defaultSourceId) {
      logger.debug(`${LABEL} (SQLite): sources table missing, nothing to promote`);
      return;
    }

    const tx = db.transaction(() => {
      let promoted = 0;
      const ts = now();

      const insert = db.prepare(
        `INSERT INTO settings (key, value, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO NOTHING`
      );
      const readGlobal = db.prepare(`SELECT value FROM settings WHERE key = ?`);

      for (const key of PER_SOURCE_SETTINGS_KEYS) {
        const globalRow = readGlobal.get(key) as { value: string } | undefined;
        if (!globalRow) continue;

        const prefixedKey = `source:${defaultSourceId}:${key}`;
        const result = insert.run(prefixedKey, globalRow.value, ts, ts);
        if (result.changes > 0) promoted++;
      }

      if (promoted > 0) {
        logger.info(`${LABEL} (SQLite): promoted ${promoted} setting(s) into source:${defaultSourceId}:`);
      }

      // Backfill orphan NULL-sourceId rows in auto_traceroute_nodes and
      // auto_time_sync_nodes. Same legacy issue: the column was added in
      // migration 024 but pre-existing rows kept NULL.
      let backfillTraceroute = 0;
      let backfillTimesync = 0;
      try {
        const r = db
          .prepare(`UPDATE auto_traceroute_nodes SET sourceId = ? WHERE sourceId IS NULL`)
          .run(defaultSourceId);
        backfillTraceroute = r.changes ?? 0;
      } catch {
        // table missing on very old DBs — fine
      }
      try {
        const r = db
          .prepare(`UPDATE auto_time_sync_nodes SET sourceId = ? WHERE sourceId IS NULL`)
          .run(defaultSourceId);
        backfillTimesync = r.changes ?? 0;
      } catch {
        // table missing — fine
      }

      if (backfillTraceroute > 0) {
        logger.info(`${LABEL} (SQLite): backfilled ${backfillTraceroute} auto_traceroute_nodes row(s) -> ${defaultSourceId}`);
      }
      if (backfillTimesync > 0) {
        logger.info(`${LABEL} (SQLite): backfilled ${backfillTimesync} auto_time_sync_nodes row(s) -> ${defaultSourceId}`);
      }
    });

    tx();
  },
};

export async function runMigration050Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): promoting legacy global settings to default source`);

  const defaultSourceId = await ensureDefaultSourceIdPostgres(client, LABEL);
  if (!defaultSourceId) {
    logger.debug(`${LABEL} (PostgreSQL): sources table missing, nothing to promote`);
    return;
  }

  await client.query('BEGIN');
  try {
    let promoted = 0;
    const ts = now();

    for (const key of PER_SOURCE_SETTINGS_KEYS) {
      const globalRes = await client.query(
        `SELECT value FROM settings WHERE key = $1`,
        [key],
      );
      if (globalRes.rowCount === 0) continue;

      const prefixedKey = `source:${defaultSourceId}:${key}`;
      const ins = await client.query(
        `INSERT INTO settings (key, value, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [prefixedKey, globalRes.rows[0].value, ts, ts],
      );
      if ((ins.rowCount ?? 0) > 0) promoted++;
    }

    if (promoted > 0) {
      logger.info(`${LABEL} (PostgreSQL): promoted ${promoted} setting(s) into source:${defaultSourceId}:`);
    }

    let backfillTraceroute = 0;
    let backfillTimesync = 0;
    try {
      const r = await client.query(
        `UPDATE auto_traceroute_nodes SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
        [defaultSourceId],
      );
      backfillTraceroute = r.rowCount ?? 0;
    } catch {
      // table missing — fine
    }
    try {
      const r = await client.query(
        `UPDATE auto_time_sync_nodes SET "sourceId" = $1 WHERE "sourceId" IS NULL`,
        [defaultSourceId],
      );
      backfillTimesync = r.rowCount ?? 0;
    } catch {
      // table missing — fine
    }

    if (backfillTraceroute > 0) {
      logger.info(`${LABEL} (PostgreSQL): backfilled ${backfillTraceroute} auto_traceroute_nodes row(s) -> ${defaultSourceId}`);
    }
    if (backfillTimesync > 0) {
      logger.info(`${LABEL} (PostgreSQL): backfilled ${backfillTimesync} auto_time_sync_nodes row(s) -> ${defaultSourceId}`);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`${LABEL} (PostgreSQL) failed:`, error);
    throw error;
  }
}

export async function runMigration050Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): promoting legacy global settings to default source`);

  const defaultSourceId = await ensureDefaultSourceIdMysql(pool, LABEL);
  if (!defaultSourceId) {
    logger.debug(`${LABEL} (MySQL): sources table missing, nothing to promote`);
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let promoted = 0;
    const ts = now();

    for (const key of PER_SOURCE_SETTINGS_KEYS) {
      const [globalRows] = await conn.query(
        `SELECT value FROM settings WHERE \`key\` = ?`,
        [key],
      );
      const row = (globalRows as Array<{ value: string }>)[0];
      if (!row) continue;

      const prefixedKey = `source:${defaultSourceId}:${key}`;
      const [ins] = await conn.query(
        `INSERT IGNORE INTO settings (\`key\`, \`value\`, createdAt, updatedAt)
         VALUES (?, ?, ?, ?)`,
        [prefixedKey, row.value, ts, ts],
      );
      const affected = (ins as { affectedRows?: number }).affectedRows ?? 0;
      if (affected > 0) promoted++;
    }

    if (promoted > 0) {
      logger.info(`${LABEL} (MySQL): promoted ${promoted} setting(s) into source:${defaultSourceId}:`);
    }

    let backfillTraceroute = 0;
    let backfillTimesync = 0;
    try {
      const [r] = await conn.query(
        `UPDATE auto_traceroute_nodes SET sourceId = ? WHERE sourceId IS NULL`,
        [defaultSourceId],
      );
      backfillTraceroute = (r as { affectedRows?: number }).affectedRows ?? 0;
    } catch {
      // table missing — fine
    }
    try {
      const [r] = await conn.query(
        `UPDATE auto_time_sync_nodes SET sourceId = ? WHERE sourceId IS NULL`,
        [defaultSourceId],
      );
      backfillTimesync = (r as { affectedRows?: number }).affectedRows ?? 0;
    } catch {
      // table missing — fine
    }

    if (backfillTraceroute > 0) {
      logger.info(`${LABEL} (MySQL): backfilled ${backfillTraceroute} auto_traceroute_nodes row(s) -> ${defaultSourceId}`);
    }
    if (backfillTimesync > 0) {
      logger.info(`${LABEL} (MySQL): backfilled ${backfillTimesync} auto_time_sync_nodes row(s) -> ${defaultSourceId}`);
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    logger.error(`${LABEL} (MySQL) failed:`, error);
    throw error;
  } finally {
    conn.release();
  }
}
