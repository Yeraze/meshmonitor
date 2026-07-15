/**
 * Migration 119: add a `reason` column to `ignored_nodes` (MQTT Geo-Ignore
 * epic, Phase 1).
 *
 * Distinguishes nodes that were manually blocklisted by a user
 * (`reason = 'manual'`) from nodes ignored automatically by the geo-fence
 * filter (`reason = 'geo'`). The default of `'manual'` preserves the
 * semantics of every pre-existing row — they were all added via the manual
 * ignore flow before this epic — with no backfill required.
 *
 * Manual ignores always upgrade a row to `reason = 'manual'` (even if it was
 * previously `'geo'`); geo ignores never downgrade an existing `'manual'`
 * row. See `IgnoredNodesRepository.addIgnoredNodeAsync` /
 * `addGeoIgnoreAsync` / `liftGeoIgnoreAsync`.
 */
import type { Database } from 'better-sqlite3';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

// ─── SQLite ────────────────────────────────────────────────────────────────────

export const migration = {
  up: (db: Database): void => {
    addColumnIfMissing(db, 'ignored_nodes', 'reason', "reason TEXT NOT NULL DEFAULT 'manual'");
  },
};

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

export async function runMigration119Postgres(client: import('pg').PoolClient): Promise<void> {
  await addColumnIfMissingPostgres(client, 'ignored_nodes', 'reason', '"reason" TEXT NOT NULL DEFAULT \'manual\'');
}

// ─── MySQL ─────────────────────────────────────────────────────────────────────

export async function runMigration119Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await addColumnIfMissingMysql(pool, 'ignored_nodes', 'reason', "reason VARCHAR(16) NOT NULL DEFAULT 'manual'");
}
