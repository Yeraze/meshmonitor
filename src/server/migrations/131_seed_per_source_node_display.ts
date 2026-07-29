/**
 * Migration 131: seed the per-source Node Display settings (#4412 Phase 1 WP4).
 *
 * Phase 2 converts several server reads to `getSettingForSource(sourceId, key)`,
 * which by design has NO fallback to the global row (#2839/#2840). Without this
 * migration, every source other than the one that happens to already carry a
 * `source:{id}:{key}` row would silently read `null` on upgrade until a user
 * happened to save the Node Display panel for that source. This migration
 * copies the current global value (or the documented default) into
 * `source:{id}:{key}` for all ten Node Display keys and every existing source,
 * so Phase 2's read conversion is a no-op from the user's point of view.
 *
 * Ten keys, verified against source at migration-authoring time
 * (PER_SOURCE_NODE_DISPLAY_PHASE1_SPEC.md §5.1):
 *   maxNodeAgeHours                   '24'
 *   inactiveNodeThresholdHours        '24'
 *   inactiveNodeCheckIntervalMinutes  '60'
 *   inactiveNodeCooldownHours         '24'
 *   localStatsIntervalMinutes         '15'
 *   nodeHopsCalculation               'nodeinfo'
 *   hideIncompleteNodes               '0'   (NOT 'false' — see below)
 *   nodeDimmingEnabled                '0'   (NOT 'false')
 *   nodeDimmingStartHours             '1'
 *   nodeDimmingMinOpacity             '0.3'
 *
 * Booleans in this group are persisted as '1'/'0', not 'true'/'false'
 * (SettingsTab.tsx writes `... ? '1' : '0'`; App.tsx/SettingsTab.tsx read back
 * with `=== '1'`). Seeding 'false' would be silently falsy-but-wrong forever,
 * since nothing in this group ever compares against the string 'false'.
 *
 * Deliberately does NOT import PER_SOURCE_SETTINGS_KEYS (contrast migration
 * 050): a migration is a statement about a point in time, and on a fresh
 * install migrations replay from scratch (#3962 — createTables was deleted),
 * so an imported array would run against whatever it contains *today*, not
 * what it contained when 131 shipped. The ten keys and their defaults are
 * frozen here as a local constant instead.
 *
 * Source enumeration is TABLE-DRIVEN (`SELECT id FROM sources`), never
 * derived from existing `source:{id}:` prefixes in `settings` (contrast
 * migration 093's prefix scan) — a source that has never had a single
 * setting written has zero `source:{id}:` rows today, and skipping it would
 * be exactly the freshly-added-second-source case this epic targets. Never
 * synthesizes a source when `sources` is empty (that is `_legacyDefaultSource`'s
 * job, and it is wrong here).
 *
 * Insert-if-absent on the `key` primary key, so re-running never clobbers a
 * value a user already set per-source. Inserts are batched (`SEED_BATCH_SIZE`
 * rows per round trip) rather than one row at a time — see #4233, the
 * migration-030 incident this pattern exists to avoid.
 */
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 131';

export interface SettingRow { key: string; value: string }

/**
 * Ten Node Display keys and their documented defaults, frozen at migration
 * authoring time. Do NOT replace with an import of a mutable constants array
 * — see the file-level doc comment.
 */
export const NODE_DISPLAY_SEED: ReadonlyArray<readonly [key: string, fallback: string]> = [
  ['maxNodeAgeHours', '24'],
  ['inactiveNodeThresholdHours', '24'],
  ['inactiveNodeCheckIntervalMinutes', '60'],
  ['inactiveNodeCooldownHours', '24'],
  ['localStatsIntervalMinutes', '15'],
  ['nodeHopsCalculation', 'nodeinfo'],
  ['hideIncompleteNodes', '0'],
  ['nodeDimmingEnabled', '0'],
  ['nodeDimmingStartHours', '1'],
  ['nodeDimmingMinOpacity', '0.3'],
];

/** The bare (unprefixed) key names, for the `WHERE key IN (...)` global read. */
const NODE_DISPLAY_KEYS: readonly string[] = NODE_DISPLAY_SEED.map(([key]) => key);

/**
 * Rows per multi-row INSERT (PostgreSQL/MySQL). 200 rows x 4 bound params =
 * 800 placeholders, comfortably inside PostgreSQL's 65535 limit and MySQL's
 * default max_allowed_packet. Copied from the batching pattern in
 * 030_add_source_id_to_route_segments.ts (#4233).
 */
const SEED_BATCH_SIZE = 200;

/** Split an array into fixed-size chunks. Copied from 030's `chunk<T>()`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Given every existing source id and the current global values for the ten
 * seeded keys, produce the `source:{id}:{key}` rows to insert. Pure and
 * total — the caller's INSERT-if-absent provides idempotency. Exported for
 * unit testing.
 */
export function computeSeedInserts(
  sourceIds: string[],
  globals: Record<string, string>,
): SettingRow[] {
  const out: SettingRow[] = [];
  for (const id of sourceIds) {
    for (const [key, fallback] of NODE_DISPLAY_SEED) {
      out.push({ key: `source:${id}:${key}`, value: globals[key] ?? fallback });
    }
  }
  return out;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): seeding per-source Node Display settings...`);

    let sourceIds: string[];
    try {
      sourceIds = (db.prepare(`SELECT id FROM sources`).all() as Array<{ id: string }>)
        .map((r) => r.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`${LABEL} (SQLite): sources table not present, skipping (${msg})`);
      return;
    }
    if (sourceIds.length === 0) {
      logger.debug(`${LABEL} (SQLite): no sources present, nothing to seed`);
      return;
    }

    const placeholders = NODE_DISPLAY_KEYS.map(() => '?').join(', ');
    const globalRows = db.prepare(
      `SELECT key, value FROM settings WHERE key IN (${placeholders})`
    ).all(...NODE_DISPLAY_KEYS) as SettingRow[];
    const globals: Record<string, string> = {};
    for (const row of globalRows) globals[row.key] = row.value;

    const inserts = computeSeedInserts(sourceIds, globals);
    if (inserts.length === 0) {
      logger.debug(`${LABEL} (SQLite): nothing to insert`);
      return;
    }

    // settings.createdAt/updatedAt are NOT NULL with no DB default — always
    // supply them (migration 093's lesson).
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, ?, ?)`
    );
    const tx = db.transaction((items: SettingRow[]) => {
      for (const it of items) stmt.run(it.key, it.value, now, now);
    });
    tx(inserts);
    logger.info(`${LABEL} (SQLite): wrote up to ${inserts.length} setting row(s) for ${sourceIds.length} source(s)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (seeded rows are harmless to leave in place)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration131Postgres(client: PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): seeding per-source Node Display settings...`);

  let sourceIds: string[];
  try {
    const { rows } = await client.query(`SELECT id FROM sources`);
    sourceIds = (rows as Array<{ id: string }>).map((r) => r.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`${LABEL} (PostgreSQL): sources table not present, skipping (${msg})`);
    return;
  }
  if (sourceIds.length === 0) {
    logger.debug(`${LABEL} (PostgreSQL): no sources present, nothing to seed`);
    return;
  }

  const inPlaceholders = NODE_DISPLAY_KEYS.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: globalRows } = await client.query(
    `SELECT key, value FROM settings WHERE key IN (${inPlaceholders})`,
    NODE_DISPLAY_KEYS as string[],
  );
  const globals: Record<string, string> = {};
  for (const row of globalRows as SettingRow[]) globals[row.key] = row.value;

  const inserts = computeSeedInserts(sourceIds, globals);
  if (inserts.length === 0) {
    logger.debug(`${LABEL} (PostgreSQL): nothing to insert`);
    return;
  }

  const now = Date.now();
  await client.query('BEGIN');
  try {
    let written = 0;
    for (const batch of chunk(inserts, SEED_BATCH_SIZE)) {
      const values: unknown[] = [];
      const tuples = batch.map((row, i) => {
        const b = i * 4;
        values.push(row.key, row.value, now, now);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
      });
      await client.query(
        `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ${tuples.join(', ')} ON CONFLICT (key) DO NOTHING`,
        values,
      );
      written += batch.length;
    }
    await client.query('COMMIT');
    logger.info(`${LABEL} (PostgreSQL): wrote up to ${written} setting row(s) for ${sourceIds.length} source(s)`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ============ MySQL ============

export async function runMigration131Mysql(pool: MySQLPool): Promise<void> {
  logger.info(`${LABEL} (MySQL): seeding per-source Node Display settings...`);
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
    if (sourceIds.length === 0) {
      logger.debug(`${LABEL} (MySQL): no sources present, nothing to seed`);
      return;
    }

    const inPlaceholders = NODE_DISPLAY_KEYS.map(() => '?').join(', ');
    const [globalRows] = await conn.query(
      `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${inPlaceholders})`,
      NODE_DISPLAY_KEYS as string[],
    );
    const globals: Record<string, string> = {};
    for (const row of globalRows as SettingRow[]) globals[row.key] = row.value;

    const inserts = computeSeedInserts(sourceIds, globals);
    if (inserts.length === 0) {
      logger.debug(`${LABEL} (MySQL): nothing to insert`);
      return;
    }

    const now = Date.now();
    await conn.beginTransaction();
    try {
      const INSERT_PREFIX = 'INSERT IGNORE INTO settings (`key`, value, createdAt, updatedAt) VALUES ';
      const ROW_TUPLE = '(?, ?, ?, ?)';
      let written = 0;
      for (const batch of chunk(inserts, SEED_BATCH_SIZE)) {
        await conn.query(
          INSERT_PREFIX + batch.map(() => ROW_TUPLE).join(', '),
          batch.flatMap((row) => [row.key, row.value, now, now]),
        );
        written += batch.length;
      }
      await conn.commit();
      logger.info(`${LABEL} (MySQL): wrote up to ${written} setting row(s) for ${sourceIds.length} source(s)`);
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
}
