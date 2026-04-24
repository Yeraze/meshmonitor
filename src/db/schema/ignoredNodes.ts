/**
 * Drizzle schema definition for the ignored_nodes table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * Scoping model (migration 048): per-source. Each source has its own
 * blocklist, keyed on `(nodeNum, sourceId)`. The `sourceId` column is a FK to
 * `sources(id)` with ON DELETE CASCADE — when a source is removed, its
 * ignored entries go with it. Ignoring on source A does NOT affect source B's
 * blocklist, matching the per-source node identity model introduced by
 * migration 029.
 *
 * The table persists the ignored status independently of `nodes.isIgnored` so
 * that when a node is pruned by `cleanupInactiveNodes` on a given source and
 * later reappears on THAT SAME source, its ignored flag is automatically
 * restored.
 */
import { sqliteTable, text, integer, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  bigint as myBigint,
  primaryKey as myPrimaryKey,
} from 'drizzle-orm/mysql-core';

// ============ IGNORED NODES (SQLite) ============

export const ignoredNodesSqlite = sqliteTable('ignored_nodes', {
  nodeNum: integer('nodeNum').notNull(),
  sourceId: text('sourceId').notNull(),
  nodeId: text('nodeId').notNull(),
  longName: text('longName'),
  shortName: text('shortName'),
  ignoredAt: integer('ignoredAt').notNull(),
  ignoredBy: text('ignoredBy'),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.nodeNum, table.sourceId] }),
}));

// ============ IGNORED NODES (PostgreSQL) ============

export const ignoredNodesPostgres = pgTable('ignored_nodes', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  sourceId: pgText('sourceId').notNull(),
  nodeId: pgText('nodeId').notNull(),
  longName: pgText('longName'),
  shortName: pgText('shortName'),
  ignoredAt: pgBigint('ignoredAt', { mode: 'number' }).notNull(),
  ignoredBy: pgText('ignoredBy'),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.nodeNum, table.sourceId] }),
}));

// ============ IGNORED NODES (MySQL) ============

export const ignoredNodesMysql = mysqlTable('ignored_nodes', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  nodeId: myVarchar('nodeId', { length: 255 }).notNull(),
  longName: myVarchar('longName', { length: 255 }),
  shortName: myVarchar('shortName', { length: 255 }),
  ignoredAt: myBigint('ignoredAt', { mode: 'number' }).notNull(),
  ignoredBy: myVarchar('ignoredBy', { length: 255 }),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.nodeNum, table.sourceId] }),
}));

// ============ TYPE INFERENCE ============

export type IgnoredNodeSqlite = typeof ignoredNodesSqlite.$inferSelect;
export type NewIgnoredNodeSqlite = typeof ignoredNodesSqlite.$inferInsert;
export type IgnoredNodePostgres = typeof ignoredNodesPostgres.$inferSelect;
export type NewIgnoredNodePostgres = typeof ignoredNodesPostgres.$inferInsert;
export type IgnoredNodeMysql = typeof ignoredNodesMysql.$inferSelect;
export type NewIgnoredNodeMysql = typeof ignoredNodesMysql.$inferInsert;
