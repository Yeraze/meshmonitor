/**
 * PostgreSQL sequence repair.
 *
 * A PostgreSQL `SERIAL` / `IDENTITY` column draws new ids from a sequence.
 * An INSERT that supplies an explicit id (a backup restore, or the
 * `migrate-db` CLI copying rows between backends) does NOT advance that
 * sequence. The next INSERT without an id then gets `nextval()` = an id that
 * already exists: a plain insert throws a duplicate-key error, and
 * `BaseRepository.insertIgnore` (target-less `onConflictDoNothing()`)
 * silently drops the row, until the sequence climbs past the highest id.
 *
 * MySQL (InnoDB auto-increment) and SQLite (rowid / `sqlite_sequence`)
 * advance their counters on explicit-id inserts, so they need no repair.
 *
 * Lives under `src/server/migrations/` because this is raw catalog and
 * maintenance SQL with no Drizzle equivalent, and this directory is where
 * the repo allows raw SQL. Callers: migration 174, `systemRestoreService`
 * (PostgreSQL restore), and the `migrate-db` CLI.
 */
import type { ClientBase } from 'pg';

export interface ResetPostgresSequencesOptions {
  /**
   * Called when one sequence cannot be repaired. When set, the helper reports
   * the failure and moves on to the next sequence. When unset, the error is
   * thrown, which is what a caller inside a transaction wants: after a failed
   * statement PostgreSQL rejects every later one until ROLLBACK.
   */
  onError?: (sequenceName: string, error: Error) => void;
}

export interface ResetPostgresSequencesResult {
  /** Owned sequences found in the current schema. */
  checked: number;
  /** Sequences that were behind their column's MAX and got moved forward. */
  advanced: number;
  /** Sequences that failed (only non-zero when `onError` is set). */
  failed: number;
}

interface SequenceRow {
  qualified_table: string;
  quoted_column: string;
  sequence_name: string;
}

/**
 * Move every SERIAL/IDENTITY sequence in the current schema forward so its
 * next value is above the highest id already in its column.
 *
 * Forward-only: a sequence that is already ahead (or whose table is empty)
 * is left alone, so this never re-issues an id a deleted row once held and
 * is safe to run at any time, any number of times.
 *
 * Every table and column name is quoted by PostgreSQL itself (`quote_ident`)
 * in the discovery query, and pg_get_serial_sequence returns the sequence
 * name already quoted. Only catalog-produced, PostgreSQL-quoted names reach
 * the SQL text; nothing caller-supplied does.
 *
 * Runs on whatever client it is given, so a caller that has opened a
 * transaction gets the repair inside it.
 */
export async function resetPostgresSequences(
  client: ClientBase,
  options: ResetPostgresSequencesOptions = {},
): Promise<ResetPostgresSequencesResult> {
  // Sequences owned by a table column (SERIAL or IDENTITY). The first
  // argument to pg_get_serial_sequence is parsed as an SQL name, so pass it
  // pre-quoted; the column argument is taken literally.
  const discovery = await client.query<SequenceRow>(`
    SELECT
      quote_ident(n.nspname) || '.' || quote_ident(t.relname) AS qualified_table,
      quote_ident(a.attname) AS quoted_column,
      pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) AS sequence_name
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid
    WHERE n.nspname = current_schema()
      AND t.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) IS NOT NULL
    ORDER BY t.relname, a.attname
  `);

  const result: ResetPostgresSequencesResult = { checked: discovery.rows.length, advanced: 0, failed: 0 };

  for (const { qualified_table, quoted_column, sequence_name } of discovery.rows) {
    try {
      // The sequence's next value is last_value + 1 once nextval has been
      // called, else last_value itself (fresh, or setval(..., false)). Only
      // setval when MAX(col) has caught up with that next value.
      // `sequence_name` comes back from pg_get_serial_sequence already
      // schema-qualified and quoted where needed, so it is safe as a FROM
      // target; the same value is also bound as the setval() argument.
      const advanced = await client.query(
        `SELECT setval($1::regclass, m.max_id, true)
           FROM (SELECT MAX(${quoted_column})::bigint AS max_id FROM ${qualified_table}) m,
                (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END AS next_id
                   FROM ${sequence_name}) s
          WHERE m.max_id IS NOT NULL
            AND m.max_id >= s.next_id`,
        [sequence_name],
      );
      if (advanced.rowCount && advanced.rowCount > 0) result.advanced++;
    } catch (err) {
      if (!options.onError) throw err;
      result.failed++;
      options.onError(sequence_name, err as Error);
    }
  }

  return result;
}
