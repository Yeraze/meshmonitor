/**
 * Shared by the system-backup drift tests (SQLite in
 * systemBackupService.tables.test.ts, PostgreSQL and MySQL in
 * systemBackupRestore.roundTrip.pgmysql.test.ts). Test support only.
 */
import { BACKUP_TABLES, BACKUP_EXCLUDED_TABLES } from './systemBackupTables.js';

/** What to tell whoever added a table. */
export const HOW_TO_FIX =
  'Every table must be in BACKUP_TABLES or BACKUP_EXCLUDED_TABLES ' +
  '(src/server/services/systemBackupTables.ts). Back it up unless it must never leave the install; ' +
  'excluding a table, or backing up one that holds credentials, needs a security review.';

/** Tables that are neither backed up nor excluded, and list entries that match no table. */
export function classifyTables(schemaTables: Iterable<string>) {
  const tables = [...schemaTables];
  const known = new Set(tables);
  return {
    unclassified: tables.filter((t) => !BACKUP_TABLES.includes(t) && !(t in BACKUP_EXCLUDED_TABLES)).sort(),
    staleBackup: BACKUP_TABLES.filter((t) => !known.has(t)),
    staleExcluded: Object.keys(BACKUP_EXCLUDED_TABLES).filter((t) => !known.has(t)),
  };
}

/** Foreign keys whose parent is not restored before the child. */
export function misorderedForeignKeys(edges: Array<{ child: string; parent: string }>): string[] {
  const position = (t: string) => BACKUP_TABLES.indexOf(t);
  return edges
    .filter(({ child, parent }) => child !== parent && position(child) !== -1)
    .filter(({ child, parent }) => position(parent) === -1 || position(parent) > position(child))
    .map(({ child, parent }) => `${child} -> ${parent}`);
}
