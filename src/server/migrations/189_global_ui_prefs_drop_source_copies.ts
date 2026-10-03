/**
 * Migration 189: drop per-source copies of global UI preferences (#5558).
 *
 * The appearance keys (`theme`, `appearanceMode`, `darkTheme`, `lightTheme`)
 * and the other user-interface preferences below are global: the server only
 * reads them via `getSetting`, and the Settings tab saves them on the
 * unscoped POST. They were not in `GLOBAL_ONLY_SETTINGS_KEYS`, though, so a
 * `POST /api/settings?sourceId=X` carrying them wrote `source:X:theme` (etc.),
 * and the source-scoped GET let that copy beat the global value. Per-source
 * pages then rendered one theme while the landing page and Global Settings
 * (unscoped GET) rendered another.
 *
 * The code fix puts these keys in `GLOBAL_ONLY_SETTINGS_KEYS` (sourced POSTs
 * drop them; the sourced GET ignores any source copy). This migration removes
 * the stale `source:{id}:{key}` rows so they stop lingering.
 *
 * Promotion rule — so a user who only ever saved from inside a source keeps
 * the choice they see today:
 *
 *   - Appearance (the four theme keys) is judged as ONE set. If the global
 *     set is unset or still the defaults (appearanceMode unset/'system',
 *     darkTheme unset/'mocha', lightTheme unset/'latte', theme unset or one of
 *     'mocha'/'latte') AND every live source that has a copy holds the SAME
 *     four-tuple, that tuple is written to the global keys. Otherwise the
 *     global set wins and is left alone.
 *   - Every other key is judged on its own: if the global key is unset AND
 *     every live source that has a copy holds the same value, that value is
 *     promoted. A global value that is set always wins.
 *
 * "Live source" = a row in `sources`. Copies left behind by deleted sources
 * are deleted but get no vote. If `sources` cannot be read, every copy votes.
 *
 * Idempotency: after one run no `source:%:{key}` rows remain for these keys,
 * so a re-run finds nothing to promote or delete.
 *
 * The key list is FROZEN here on purpose (see migration 050/131): a migration
 * is a statement about a point in time, and fresh installs replay it.
 */
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 189';

export interface SettingRow { key: string; value: string }

/** Appearance keys, judged together as one set. Order is the tuple order. */
export const APPEARANCE_KEYS = ['appearanceMode', 'darkTheme', 'lightTheme', 'theme'] as const;

/** Other global UI preferences, each judged on its own. */
export const OTHER_UI_PREF_KEYS = [
  'iconStyle',
  'mapPinStyle',
  'mapPinColorMode',
  'nodeListStyle',
  'defaultLandingPage',
  'temperatureUnit',
  'distanceUnit',
  'timeFormat',
  'dateFormat',
  'preferredSortField',
  'preferredSortDirection',
  'preferredDashboardSortOption',
] as const;

export const GLOBAL_UI_PREF_KEYS: readonly string[] = [...APPEARANCE_KEYS, ...OTHER_UI_PREF_KEYS];

/** A global appearance value counts as "default" when unset or one of these. */
const APPEARANCE_DEFAULTS: Record<(typeof APPEARANCE_KEYS)[number], readonly string[]> = {
  appearanceMode: ['system'],
  darkTheme: ['mocha'],
  lightTheme: ['latte'],
  // `theme` is the derived effective theme; with default settings it is
  // whichever of the two default themes the system scheme picked.
  theme: ['mocha', 'latte'],
};

export interface CleanupPlan {
  /** Global keys to write (insert or overwrite). */
  promote: Record<string, string>;
  /** `source:{id}:{key}` rows to delete. */
  deleteKeys: string[];
}

/** Parse `source:{id}:{key}` for one of our keys; null when it isn't one. */
function parseSourceKey(fullKey: string): { sourceId: string; key: string } | null {
  if (!fullKey.startsWith('source:')) return null;
  const lastColon = fullKey.lastIndexOf(':');
  if (lastColon <= 'source:'.length) return null;
  const key = fullKey.slice(lastColon + 1);
  if (!GLOBAL_UI_PREF_KEYS.includes(key)) return null;
  return { sourceId: fullKey.slice('source:'.length, lastColon), key };
}

/**
 * Pure planner. `rows` are every settings row whose key is one of ours,
 * global or source-scoped. `liveSourceIds` is null when the sources table
 * could not be read (then every copy votes). Exported for unit testing.
 */
export function planGlobalUiPrefCleanup(rows: SettingRow[], liveSourceIds: string[] | null): CleanupPlan {
  const globals: Record<string, string> = {};
  // sourceId -> key -> value
  const bySource = new Map<string, Record<string, string>>();
  const deleteKeys: string[] = [];

  for (const row of rows) {
    if (GLOBAL_UI_PREF_KEYS.includes(row.key)) {
      globals[row.key] = row.value;
      continue;
    }
    const parsed = parseSourceKey(row.key);
    if (!parsed) continue;
    deleteKeys.push(row.key);
    const live = liveSourceIds === null || liveSourceIds.includes(parsed.sourceId);
    if (!live) continue;
    const entry = bySource.get(parsed.sourceId) ?? {};
    entry[parsed.key] = row.value;
    bySource.set(parsed.sourceId, entry);
  }

  const promote: Record<string, string> = {};

  // Appearance — one set.
  const globalIsDefault = APPEARANCE_KEYS.every(
    (k) => globals[k] === undefined || APPEARANCE_DEFAULTS[k].includes(globals[k]),
  );
  if (globalIsDefault) {
    const tuples = new Set<string>();
    let sample: Record<string, string> | null = null;
    for (const values of bySource.values()) {
      if (!APPEARANCE_KEYS.some((k) => values[k] !== undefined)) continue;
      tuples.add(JSON.stringify(APPEARANCE_KEYS.map((k) => values[k] ?? null)));
      sample = values;
    }
    if (tuples.size === 1 && sample) {
      for (const k of APPEARANCE_KEYS) {
        if (sample[k] !== undefined) promote[k] = sample[k];
      }
    }
  }

  // Everything else — per key.
  for (const k of OTHER_UI_PREF_KEYS) {
    if (globals[k] !== undefined) continue;
    const values = new Set<string>();
    for (const perSource of bySource.values()) {
      if (perSource[k] !== undefined) values.add(perSource[k]);
    }
    if (values.size === 1) promote[k] = [...values][0];
  }

  return { promote, deleteKeys };
}

/** `key LIKE 'source:%:<k>'` patterns. None of our keys contain `_` or `%`. */
const SOURCE_PATTERNS = GLOBAL_UI_PREF_KEYS.map((k) => `source:%:${k}`);

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const keyPh = GLOBAL_UI_PREF_KEYS.map(() => '?').join(', ');
    const likeClauses = SOURCE_PATTERNS.map(() => 'key LIKE ?').join(' OR ');
    const rows = db.prepare(
      `SELECT key, value FROM settings WHERE key IN (${keyPh}) OR ${likeClauses}`,
    ).all(...GLOBAL_UI_PREF_KEYS, ...SOURCE_PATTERNS) as SettingRow[];

    let liveSourceIds: string[] | null;
    try {
      liveSourceIds = (db.prepare(`SELECT id FROM sources`).all() as Array<{ id: string }>).map((r) => r.id);
    } catch {
      liveSourceIds = null;
    }

    const plan = planGlobalUiPrefCleanup(rows, liveSourceIds);
    if (plan.deleteKeys.length === 0) {
      logger.debug(`${LABEL} (SQLite): no per-source UI preference copies, nothing to do`);
      return;
    }

    const now = Date.now();
    const upsert = db.prepare(
      `INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    );
    const del = db.prepare(`DELETE FROM settings WHERE key = ?`);
    db.transaction(() => {
      for (const [k, v] of Object.entries(plan.promote)) upsert.run(k, v, now, now);
      for (const k of plan.deleteKeys) del.run(k);
    })();
    logger.info(
      `${LABEL} (SQLite): promoted ${Object.keys(plan.promote).length} global UI preference(s), ` +
      `removed ${plan.deleteKeys.length} per-source copy row(s)`,
    );
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (deleted rows were never read)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration189Postgres(client: PoolClient): Promise<void> {
  const keyPh = GLOBAL_UI_PREF_KEYS.map((_, i) => `$${i + 1}`).join(', ');
  const likeClauses = SOURCE_PATTERNS.map((_, i) => `key LIKE $${GLOBAL_UI_PREF_KEYS.length + i + 1}`).join(' OR ');
  const { rows } = await client.query(
    `SELECT key, value FROM settings WHERE key IN (${keyPh}) OR ${likeClauses}`,
    [...GLOBAL_UI_PREF_KEYS, ...SOURCE_PATTERNS],
  );

  // A failed statement aborts a PG transaction, so probe for the sources
  // table instead of catching a SELECT error.
  let liveSourceIds: string[] | null = null;
  const { rows: reg } = await client.query(`SELECT to_regclass('sources') AS t`);
  if ((reg as Array<{ t: string | null }>)[0]?.t) {
    const { rows: src } = await client.query(`SELECT id FROM sources`);
    liveSourceIds = (src as Array<{ id: string }>).map((r) => r.id);
  }

  const plan = planGlobalUiPrefCleanup(rows as SettingRow[], liveSourceIds);
  if (plan.deleteKeys.length === 0) {
    logger.debug(`${LABEL} (PostgreSQL): no per-source UI preference copies, nothing to do`);
    return;
  }

  const now = Date.now();
  await client.query('BEGIN');
  try {
    for (const [k, v] of Object.entries(plan.promote)) {
      await client.query(
        `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1, $2, $3, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`,
        [k, v, now],
      );
    }
    await client.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [plan.deleteKeys]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  logger.info(
    `${LABEL} (PostgreSQL): promoted ${Object.keys(plan.promote).length} global UI preference(s), ` +
    `removed ${plan.deleteKeys.length} per-source copy row(s)`,
  );
}

// ============ MySQL ============

export async function runMigration189Mysql(pool: MySQLPool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const keyPh = GLOBAL_UI_PREF_KEYS.map(() => '?').join(', ');
    const likeClauses = SOURCE_PATTERNS.map(() => '`key` LIKE ?').join(' OR ');
    const [rows] = await conn.query(
      `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${keyPh}) OR ${likeClauses}`,
      [...GLOBAL_UI_PREF_KEYS, ...SOURCE_PATTERNS],
    );

    let liveSourceIds: string[] | null;
    try {
      const [src] = await conn.query(`SELECT id FROM sources`);
      liveSourceIds = (src as Array<{ id: string }>).map((r) => r.id);
    } catch {
      liveSourceIds = null;
    }

    const plan = planGlobalUiPrefCleanup(rows as SettingRow[], liveSourceIds);
    if (plan.deleteKeys.length === 0) {
      logger.debug(`${LABEL} (MySQL): no per-source UI preference copies, nothing to do`);
      return;
    }

    const now = Date.now();
    await conn.beginTransaction();
    try {
      for (const [k, v] of Object.entries(plan.promote)) {
        await conn.query(
          'INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)',
          [k, v, now, now],
        );
      }
      const delPh = plan.deleteKeys.map(() => '?').join(', ');
      await conn.query(`DELETE FROM settings WHERE \`key\` IN (${delPh})`, plan.deleteKeys);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    logger.info(
      `${LABEL} (MySQL): promoted ${Object.keys(plan.promote).length} global UI preference(s), ` +
      `removed ${plan.deleteKeys.length} per-source copy row(s)`,
    );
  } finally {
    conn.release();
  }
}
