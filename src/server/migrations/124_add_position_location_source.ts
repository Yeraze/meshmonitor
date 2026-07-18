/**
 * Migration 124: Add `positionLocationSource` to `nodes`.
 *
 * Persists the Meshtastic `Position.location_source` (LocSource enum) that was
 * already decoded off the wire but dropped before storage (issue #4176):
 *   0 = LOC_UNSET, 1 = LOC_MANUAL, 2 = LOC_INTERNAL (GPS), 3 = LOC_EXTERNAL (GPS).
 *
 * Surfaced in the node-info popups (chat + map) alongside position accuracy.
 * Nullable with no default, so existing rows keep NULL (unknown / hidden) and
 * behave exactly as before. Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const TABLE = 'nodes';
const COLUMN = 'positionLocationSource';

// ─── SQLite ────────────────────────────────────────────────────────────────────

export const migration = {
  up: (db: Database): void => {
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
  },
};

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

export async function runMigration124Postgres(client: import('pg').PoolClient): Promise<void> {
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
}

// ─── MySQL ─────────────────────────────────────────────────────────────────────

export async function runMigration124Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} INT`);
}
