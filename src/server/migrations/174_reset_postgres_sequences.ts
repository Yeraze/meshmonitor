/**
 * Migration 174: repair PostgreSQL SERIAL/IDENTITY sequences left behind by
 * a system restore.
 *
 * Before this fix, `systemRestoreService.restorePostgres()` re-inserted every
 * row with its original id and committed without advancing the sequences.
 * On a restored install the next id-less INSERT draws an id that already
 * exists: plain inserts fail with a duplicate key, and `insertIgnore`
 * (`onConflictDoNothing()` with no target) silently drops the row. The
 * restore path now repairs sequences itself; this migration fixes installs
 * that were restored before it did.
 *
 * `resetPostgresSequences` only moves a sequence forward, and only when its
 * column's MAX has caught up with it, so the migration is idempotent and a
 * no-op on a fresh or healthy database. A single sequence that cannot be
 * repaired is logged and skipped rather than blocking boot (PG migrations run
 * in autocommit, so one failure does not poison the rest).
 *
 * SQLite and MySQL are no-ops: SQLite's rowid / `sqlite_sequence` and
 * InnoDB's AUTO_INCREMENT both advance on explicit-id inserts.
 */
import type { Database } from 'better-sqlite3';
import type { ClientBase } from 'pg';
import { logger } from '../../utils/logger.js';
import { resetPostgresSequences } from './postgresSequences.js';

const LABEL = 'Migration 174';

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    logger.debug(`${LABEL} (SQLite): no-op, rowid/sqlite_sequence advance on explicit-id inserts`);
  },
};

// ============ PostgreSQL ============

export async function runMigration174Postgres(client: ClientBase): Promise<void> {
  const { checked, advanced, failed } = await resetPostgresSequences(client, {
    onError: (sequenceName, err) => {
      logger.warn(`${LABEL} (PostgreSQL): could not repair sequence ${sequenceName}: ${err.message}`);
    },
  });
  logger.info(
    `${LABEL} (PostgreSQL): checked ${checked} sequences, advanced ${advanced}` +
      (failed > 0 ? `, ${failed} failed` : ''),
  );
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql2 Pool; unused, the MySQL runner is a no-op
export async function runMigration174Mysql(_pool: any): Promise<void> {
  logger.debug(`${LABEL} (MySQL): no-op, InnoDB AUTO_INCREMENT advances on explicit-id inserts`);
}
