/**
 * Migration 195: one translation API key per provider (#5518).
 *
 * Until now every translation provider read the same `translationApiKey`
 * setting. Switching provider reused the stored key, so a DeepL key went out
 * as a Bearer token to whatever OpenAI-compatible URL was configured. Each
 * provider now owns its key:
 *
 *   libretranslate → translationLibreTranslateApiKey
 *   openai         → translationOpenAiApiKey
 *   deepl          → translationDeeplApiKey
 *   google         → translationGoogleApiKey
 *
 * This migration moves the stored `translationApiKey` to the ACTIVE
 * provider's key only (active = stored `translationProvider`; unset or
 * unknown reads as `libretranslate`, as the code defaults it). The other
 * providers start blank: the old key was only ever known to work with the
 * active one. The old row is then removed so no stale secret stays behind,
 * along with any `source:{id}:translationApiKey` copy (the key was always
 * global-only, so none is expected).
 *
 * Never overwrites: if the active provider's new key already holds a
 * non-blank value, that value is kept and the old key is just dropped.
 *
 * Idempotency: after one run there is no `translationApiKey` row, so a
 * re-run finds nothing to move or delete.
 *
 * The provider → key map is FROZEN here on purpose (see migrations 050/131/
 * 189): a migration is a statement about a point in time, and fresh installs
 * replay it. Do not import the provider descriptors.
 */
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 195';

export const OLD_API_KEY = 'translationApiKey';
export const PROVIDER_KEY = 'translationProvider';
const DEFAULT_PROVIDER = 'libretranslate';

export const PROVIDER_API_KEYS: Readonly<Record<string, string>> = {
  libretranslate: 'translationLibreTranslateApiKey',
  openai: 'translationOpenAiApiKey',
  deepl: 'translationDeeplApiKey',
  google: 'translationGoogleApiKey',
};

const NEW_KEYS = Object.values(PROVIDER_API_KEYS);
/** `source:{id}:translationApiKey`. The key holds no `_` or `%`. */
const OLD_SOURCE_PATTERN = `source:%:${OLD_API_KEY}`;
const READ_KEYS = [OLD_API_KEY, PROVIDER_KEY, ...NEW_KEYS];

export interface SettingRow { key: string; value: string }

export interface SplitPlan {
  /** The one row to write (the active provider's new key), or null. */
  write: SettingRow | null;
  /** Rows to delete: the old key and any per-source copy of it. */
  deleteKeys: string[];
}

/**
 * Pure planner. `rows` are the settings rows for the old key (global and
 * per-source copies), `translationProvider`, and the four new keys.
 * Exported for unit testing.
 */
export function planTranslationApiKeySplit(rows: SettingRow[]): SplitPlan {
  const byKey = new Map(rows.map((r) => [r.key, r.value ?? '']));
  const deleteKeys = rows
    .map((r) => r.key)
    .filter((k) => k === OLD_API_KEY || (k.startsWith('source:') && k.endsWith(`:${OLD_API_KEY}`)));

  if (!byKey.has(OLD_API_KEY)) return { write: null, deleteKeys };

  const oldValue = (byKey.get(OLD_API_KEY) ?? '').trim();
  const provider = byKey.get(PROVIDER_KEY) ?? '';
  const target = Object.prototype.hasOwnProperty.call(PROVIDER_API_KEYS, provider)
    ? PROVIDER_API_KEYS[provider]
    : PROVIDER_API_KEYS[DEFAULT_PROVIDER];
  const existing = (byKey.get(target) ?? '').trim();

  const write = oldValue && !existing ? { key: target, value: oldValue } : null;
  return { write, deleteKeys };
}

function describe(plan: SplitPlan): string {
  return plan.write
    ? `moved the stored translation API key to ${plan.write.key}, removed ${plan.deleteKeys.length} old row(s)`
    : `removed ${plan.deleteKeys.length} old translation API key row(s), nothing to move`;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const ph = READ_KEYS.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT key, value FROM settings WHERE key IN (${ph}) OR key LIKE ?`,
    ).all(...READ_KEYS, OLD_SOURCE_PATTERN) as SettingRow[];

    const plan = planTranslationApiKeySplit(rows);
    if (!plan.write && plan.deleteKeys.length === 0) {
      logger.debug(`${LABEL} (SQLite): no shared translation API key, nothing to do`);
      return;
    }

    const now = Date.now();
    const upsert = db.prepare(
      `INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    );
    const del = db.prepare(`DELETE FROM settings WHERE key = ?`);
    db.transaction(() => {
      if (plan.write) upsert.run(plan.write.key, plan.write.value, now, now);
      for (const k of plan.deleteKeys) del.run(k);
    })();
    logger.info(`${LABEL} (SQLite): ${describe(plan)}`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (the shared key is not restored)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration195Postgres(client: PoolClient): Promise<void> {
  const ph = READ_KEYS.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await client.query(
    `SELECT key, value FROM settings WHERE key IN (${ph}) OR key LIKE $${READ_KEYS.length + 1}`,
    [...READ_KEYS, OLD_SOURCE_PATTERN],
  );

  const plan = planTranslationApiKeySplit(rows as SettingRow[]);
  if (!plan.write && plan.deleteKeys.length === 0) {
    logger.debug(`${LABEL} (PostgreSQL): no shared translation API key, nothing to do`);
    return;
  }

  const now = Date.now();
  await client.query('BEGIN');
  try {
    if (plan.write) {
      await client.query(
        `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ($1, $2, $3, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`,
        [plan.write.key, plan.write.value, now],
      );
    }
    await client.query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [plan.deleteKeys]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  logger.info(`${LABEL} (PostgreSQL): ${describe(plan)}`);
}

// ============ MySQL ============

export async function runMigration195Mysql(pool: MySQLPool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    const ph = READ_KEYS.map(() => '?').join(', ');
    const [rows] = await conn.query(
      `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${ph}) OR \`key\` LIKE ?`,
      [...READ_KEYS, OLD_SOURCE_PATTERN],
    );

    const plan = planTranslationApiKeySplit(rows as SettingRow[]);
    if (!plan.write && plan.deleteKeys.length === 0) {
      logger.debug(`${LABEL} (MySQL): no shared translation API key, nothing to do`);
      return;
    }

    const now = Date.now();
    await conn.beginTransaction();
    try {
      if (plan.write) {
        await conn.query(
          'INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)',
          [plan.write.key, plan.write.value, now, now],
        );
      }
      if (plan.deleteKeys.length > 0) {
        const delPh = plan.deleteKeys.map(() => '?').join(', ');
        await conn.query(`DELETE FROM settings WHERE \`key\` IN (${delPh})`, plan.deleteKeys);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
    logger.info(`${LABEL} (MySQL): ${describe(plan)}`);
  } finally {
    conn.release();
  }
}
