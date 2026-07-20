/**
 * Migration Ledger (PostgreSQL / MySQL)
 *
 * SQLite has always tracked applied migrations by writing each migration's
 * `settingsKey` into the `settings` table (see the SQLite loop in
 * `DatabaseService.runMigrations`). PostgreSQL and MySQL had no equivalent —
 * their loops re-ran *every* registered migration on *every* boot and relied
 * entirely on each migration being internally idempotent.
 *
 * That assumption broke down (see #4233): migration 030 unconditionally
 * cleared and rebuilt `route_segments`, so every restart wiped and re-inserted
 * the whole table — hundreds of thousands of rows on a mature install.
 *
 * This module gives PG/MySQL the same ledger SQLite uses, keyed off the same
 * `settingsKey` values and stored in the same `settings` table. Keeping the
 * mechanism identical across all three backends means a SQLite → PostgreSQL
 * restore carries its migration history with it.
 *
 * Migration 001 is the baseline that *creates* the `settings` table, so it
 * carries no `settingsKey` and always runs unguarded (it is pure
 * `CREATE TABLE IF NOT EXISTS`). Migrations 002+ are guarded. This mirrors
 * SQLite, where `migrations.test.ts` already asserts 001 has no `settingsKey`
 * and 002+ all do.
 */

import { logger } from '../utils/logger.js';
import type { MigrationEntry } from './migrationRegistry.js';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';

/** Value written for a migration that has been applied. Matches SQLite. */
export const MIGRATION_COMPLETED = 'completed';

/**
 * Read the set of already-applied migration keys.
 *
 * Returns an empty set when the `settings` table does not exist yet — that is
 * the fresh-install case, where migration 001 is about to create it.
 *
 * Scoped to the `public` schema, matching every other `information_schema`
 * lookup in the PostgreSQL path (the pre-v3.7 detection in
 * `createPostgresSchema`, migration 030's column check, and others). A
 * deployment using a non-`public` search_path would not be found here — but it
 * would equally not be found by any of those, so the assumption is consistent
 * repo-wide rather than introduced by the ledger. Changing it means changing
 * all of them together.
 */
export async function readAppliedMigrationsPostgres(client: PoolClient): Promise<Set<string>> {
  const exists = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'settings'
    ) as exists
  `);
  if (!exists.rows[0]?.exists) return new Set();

  const { rows } = await client.query(
    `SELECT key FROM settings WHERE key LIKE 'migration_%' AND value = $1`,
    [MIGRATION_COMPLETED],
  );
  return new Set(rows.map((r: { key: string }) => r.key));
}

/** Record a migration as applied. Idempotent. */
export async function markMigrationAppliedPostgres(client: PoolClient, key: string): Promise<void> {
  const now = Date.now();
  await client.query(
    `INSERT INTO settings (key, value, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`,
    [key, MIGRATION_COMPLETED, now],
  );
}

/**
 * Read the set of already-applied migration keys.
 *
 * Returns an empty set when the `settings` table does not exist yet.
 */
export async function readAppliedMigrationsMysql(pool: MySQLPool): Promise<Set<string>> {
  const [tableRows] = await pool.query(
    `SELECT COUNT(*) as count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settings'`,
  );
  if (Number((tableRows as Array<{ count: number }>)[0]?.count) === 0) return new Set();

  const [rows] = await pool.query(
    'SELECT `key` FROM settings WHERE `key` LIKE \'migration_%\' AND value = ?',
    [MIGRATION_COMPLETED],
  );
  return new Set((rows as Array<{ key: string }>).map(r => r.key));
}

/** Record a migration as applied. Idempotent. */
export async function markMigrationAppliedMysql(pool: MySQLPool, key: string): Promise<void> {
  const now = Date.now();
  await pool.query(
    'INSERT INTO settings (`key`, value, createdAt, updatedAt) VALUES (?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)',
    [key, MIGRATION_COMPLETED, now, now],
  );
}

/**
 * Run a registry's migrations against one backend, skipping any already
 * recorded in the ledger and recording each one that runs.
 *
 * Shared by the PostgreSQL and MySQL paths so the guard logic exists once.
 * A migration with no `settingsKey` (only 001, the baseline) always runs —
 * it is what creates the `settings` table the ledger lives in.
 *
 * On the first boot after the ledger is introduced the applied-set is empty,
 * so every migration replays once and is then recorded. There is deliberately
 * no backfill: there is no way to know which migrations actually ran against
 * a given pre-existing database, so they are re-run (they are expected to be
 * idempotent) rather than assumed done.
 */
export async function runLedgeredMigrations<H>(opts: {
  backend: string;
  handle: H;
  migrations: ReadonlyArray<MigrationEntry>;
  /** Extract this backend's migration function, or undefined if it has none. */
  pick: (m: MigrationEntry) => ((handle: H) => Promise<void>) | undefined;
  readApplied: (handle: H) => Promise<Set<string>>;
  markApplied: (handle: H, key: string) => Promise<void>;
}): Promise<{ ran: number; skipped: number }> {
  const { backend, handle, migrations, pick, readApplied, markApplied } = opts;

  const applied = await readApplied(handle);
  let ran = 0;
  let skipped = 0;

  for (const migration of migrations) {
    const fn = pick(migration);
    if (!fn) continue;

    if (migration.settingsKey && applied.has(migration.settingsKey)) {
      skipped++;
      continue;
    }

    const label = `${String(migration.number).padStart(3, '0')} (${migration.name})`;
    logger.debug(`[${backend}] Running migration ${label}...`);
    await fn(handle);
    ran++;

    // Recorded only after the migration resolves. If the process dies between
    // the two, the migration re-runs on the next boot — which is why every
    // PG/MySQL migration must remain internally idempotent.
    if (migration.settingsKey) {
      await markApplied(handle, migration.settingsKey);
    }
  }

  if (skipped > 0) {
    logger.info(`[${backend}] Skipped ${skipped} already-applied migration(s), ran ${ran}`);
  } else if (ran > 0) {
    // No ledger entries: either a fresh install, or an existing database on
    // its first boot since the ledger was introduced. Both run everything
    // once and record it; neither repeats.
    logger.info(`[${backend}] Ran ${ran} migration(s), now recorded in the ledger`);
  }

  return { ran, skipped };
}
