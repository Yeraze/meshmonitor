/**
 * Drizzle schema definition for the ignored_nodes table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * This table persists the ignored status of nodes independently of the nodes table,
 * so that when a node is pruned by cleanupInactiveNodes and later reappears,
 * its ignored status is automatically restored.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  bigint as myBigint,
} from 'drizzle-orm/mysql-core';

// ============ IGNORED NODES (SQLite) ============

export const ignoredNodesSqlite = sqliteTable('ignored_nodes', {
  nodeNum: integer('nodeNum').primaryKey(),
  nodeId: text('nodeId').notNull(),
  longName: text('longName'),
  shortName: text('shortName'),
  ignoredAt: integer('ignoredAt').notNull(),
  ignoredBy: text('ignoredBy'),
});

// ============ IGNORED NODES (PostgreSQL) ============

export const ignoredNodesPostgres = pgTable('ignored_nodes', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: pgText('nodeId').notNull(),
  longName: pgText('longName'),
  shortName: pgText('shortName'),
  ignoredAt: pgBigint('ignoredAt', { mode: 'number' }).notNull(),
  ignoredBy: pgText('ignoredBy'),
});

// ============ IGNORED NODES (MySQL) ============

export const ignoredNodesMysql = mysqlTable('ignored_nodes', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: myVarchar('nodeId', { length: 255 }).notNull(),
  longName: myVarchar('longName', { length: 255 }),
  shortName: myVarchar('shortName', { length: 255 }),
  ignoredAt: myBigint('ignoredAt', { mode: 'number' }).notNull(),
  ignoredBy: myVarchar('ignoredBy', { length: 255 }),
});

// ============ TYPE INFERENCE ============

export type IgnoredNodeSqlite = typeof ignoredNodesSqlite.$inferSelect;
export type NewIgnoredNodeSqlite = typeof ignoredNodesSqlite.$inferInsert;
export type IgnoredNodePostgres = typeof ignoredNodesPostgres.$inferSelect;
export type NewIgnoredNodePostgres = typeof ignoredNodesPostgres.$inferInsert;
export type IgnoredNodeMysql = typeof ignoredNodesMysql.$inferSelect;
export type NewIgnoredNodeMysql = typeof ignoredNodesMysql.$inferInsert;
