/**
 * Drizzle schema for the `coverage_imports` table (Walkabout Coverage epic
 * #5891, Phase 3). PER-SOURCE (`sourceId` = the target source).
 *
 * One row per imported Coverage Report file (CSV or GeoJSON). The rows it
 * brought in live in `coverage_receptions` with `importId = coverage_imports.id`.
 * `kind` is `'coverage_report'` today; P3b may add `'walkabout'` without a
 * migration. No foreign keys: the repository deletes the reception rows first.
 *
 * `id` is a UUID text primary key (`crypto.randomUUID()`), not serial: see
 * migration 173's header for the PG-sequence trap this avoids on restore.
 * `importedBy` is `users.id`, never sent to the client.
 *
 * Indexes (declared in migration 249, not here; project convention):
 *  - UNIQUE `cov_imp_source_sha_uniq (sourceId, fileSha256)` — file dedupe.
 *  - `cov_imp_source_imported_idx (sourceId, importedAt)` — newest-first list.
 * Spec: WALKABOUT_P3_SPEC.md §3.1.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, boolean as pgBoolean } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, boolean as myBoolean } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const coverageImportsSqlite = sqliteTable('coverage_imports', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  kind: text('kind').notNull(),
  format: text('format').notNull(),
  filename: text('filename').notNull(),
  fileSha256: text('fileSha256').notNull(),
  status: text('status').notNull(),
  importedBy: integer('importedBy'),
  importedAt: integer('importedAt').notNull(),
  rowCount: integer('rowCount').notNull(),
  insertedCount: integer('insertedCount').notNull(),
  duplicateCount: integer('duplicateCount').notNull(),
  skippedCount: integer('skippedCount').notNull(),
  firstReceivedAt: integer('firstReceivedAt'),
  lastReceivedAt: integer('lastReceivedAt'),
  sourceTruncated: integer('sourceTruncated', { mode: 'boolean' }).notNull().default(false),
});

// ============ PostgreSQL Schema ============

export const coverageImportsPostgres = pgTable('coverage_imports', {
  id: pgText('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  kind: pgText('kind').notNull(),
  format: pgText('format').notNull(),
  filename: pgText('filename').notNull(),
  fileSha256: pgText('fileSha256').notNull(),
  status: pgText('status').notNull(),
  importedBy: pgInteger('importedBy'),
  importedAt: pgBigint('importedAt', { mode: 'number' }).notNull(),
  rowCount: pgInteger('rowCount').notNull(),
  insertedCount: pgInteger('insertedCount').notNull(),
  duplicateCount: pgInteger('duplicateCount').notNull(),
  skippedCount: pgInteger('skippedCount').notNull(),
  firstReceivedAt: pgBigint('firstReceivedAt', { mode: 'number' }),
  lastReceivedAt: pgBigint('lastReceivedAt', { mode: 'number' }),
  sourceTruncated: pgBoolean('sourceTruncated').notNull().default(false),
});

// ============ MySQL Schema ============

export const coverageImportsMysql = mysqlTable('coverage_imports', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  kind: myVarchar('kind', { length: 24 }).notNull(),
  format: myVarchar('format', { length: 8 }).notNull(),
  filename: myVarchar('filename', { length: 200 }).notNull(),
  fileSha256: myVarchar('fileSha256', { length: 64 }).notNull(),
  status: myVarchar('status', { length: 12 }).notNull(),
  importedBy: myInt('importedBy'),
  importedAt: myBigint('importedAt', { mode: 'number' }).notNull(),
  rowCount: myInt('rowCount').notNull(),
  insertedCount: myInt('insertedCount').notNull(),
  duplicateCount: myInt('duplicateCount').notNull(),
  skippedCount: myInt('skippedCount').notNull(),
  firstReceivedAt: myBigint('firstReceivedAt', { mode: 'number' }),
  lastReceivedAt: myBigint('lastReceivedAt', { mode: 'number' }),
  sourceTruncated: myBoolean('sourceTruncated').notNull().default(false),
});

// ============ Type Inference ============

export type CoverageImportSqlite = typeof coverageImportsSqlite.$inferSelect;
export type NewCoverageImportSqlite = typeof coverageImportsSqlite.$inferInsert;
export type CoverageImportPostgres = typeof coverageImportsPostgres.$inferSelect;
export type NewCoverageImportPostgres = typeof coverageImportsPostgres.$inferInsert;
export type CoverageImportMysql = typeof coverageImportsMysql.$inferSelect;
export type NewCoverageImportMysql = typeof coverageImportsMysql.$inferInsert;
