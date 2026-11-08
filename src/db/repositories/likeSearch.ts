/**
 * Shared SQL LIKE helper (extracted from packetLog.ts, #6262 P4).
 *
 * The user's `%`/`_` must match literally, so they are escaped and an explicit
 * ESCAPE char is declared (SQLite has no default escape char). The escape char
 * is `~`, NOT `\`: a backslash `ESCAPE '\'` breaks MySQL, where `\` escapes the
 * closing quote inside the literal. `~` is a plain literal in all three
 * backends. Postgres LIKE is case-sensitive, so it uses ILIKE; SQLite/MySQL
 * LIKE are case-insensitive by default.
 */
import { sql, type SQL } from 'drizzle-orm';

/** Escape `~`, `%`, `_` for use inside a LIKE pattern with `ESCAPE '~'`. */
export function escapeLike(term: string): string {
  return term.replace(/[~%_]/g, (c: string) => `~${c}`);
}

/**
 * `(col1 LIKE %term% ESCAPE '~' OR col2 LIKE ...)`. `columns` must be non-empty.
 * `mode` 'prefix' matches `term%`, 'suffix' matches `%term`.
 */
export function likeContains(
  columns: SQL[],
  term: string,
  isPostgres: boolean,
  mode: 'contains' | 'prefix' | 'suffix' = 'contains',
): SQL {
  const escaped = escapeLike(term);
  const like = mode === 'prefix' ? `${escaped}%` : mode === 'suffix' ? `%${escaped}` : `%${escaped}%`;
  const op = isPostgres ? sql.raw('ILIKE') : sql.raw('LIKE');
  const parts = columns.map((c) => sql`${c} ${op} ${like} ESCAPE '~'`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}
