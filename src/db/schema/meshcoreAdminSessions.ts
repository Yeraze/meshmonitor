/**
 * Drizzle schema for `meshcore_admin_sessions` (issue #5785).
 *
 * One row per (source, remote node): the source's companion logged in to that
 * node, so the node's ACL holds our key and CLI commands can go straight out
 * without a fresh login exchange.
 *
 *   - `selfPublicKey` — the companion's own key at login time. The remote's ACL
 *     is keyed on it, so a row is honoured only while the connected companion
 *     still has this key. A different radio on the source has no session.
 *   - `loggedInAt` — epoch ms of the last successful login. Informational; a
 *     session never expires on a timer (the firmware has no idle timeout).
 *   - `isAdmin` — the LoginSuccess frame's admin flag (firmware >= 1.16), or
 *     null when the remote did not report it.
 *
 * PER-SOURCE — every row carries a `sourceId`. A side table rather than columns
 * on `meshcore_nodes` so a node purge does not drop it.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, boolean as pgBoolean } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, boolean as myBoolean } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreAdminSessionsSqlite = sqliteTable('meshcore_admin_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  targetPublicKey: text('targetPublicKey').notNull(),
  selfPublicKey: text('selfPublicKey').notNull(),
  loggedInAt: integer('loggedInAt').notNull(),
  isAdmin: integer('isAdmin', { mode: 'boolean' }),
});

// ============ PostgreSQL Schema ============

export const meshcoreAdminSessionsPostgres = pgTable('meshcore_admin_sessions', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  targetPublicKey: pgText('targetPublicKey').notNull(),
  selfPublicKey: pgText('selfPublicKey').notNull(),
  loggedInAt: pgBigint('loggedInAt', { mode: 'number' }).notNull(),
  isAdmin: pgBoolean('isAdmin'),
});

// ============ MySQL Schema ============

export const meshcoreAdminSessionsMysql = mysqlTable('meshcore_admin_sessions', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  targetPublicKey: myVarchar('targetPublicKey', { length: 64 }).notNull(),
  selfPublicKey: myVarchar('selfPublicKey', { length: 64 }).notNull(),
  loggedInAt: myBigint('loggedInAt', { mode: 'number' }).notNull(),
  isAdmin: myBoolean('isAdmin'),
});

// ============ Type Inference ============

export type MeshcoreAdminSessionSqlite = typeof meshcoreAdminSessionsSqlite.$inferSelect;
export type MeshcoreAdminSessionPostgres = typeof meshcoreAdminSessionsPostgres.$inferSelect;
export type MeshcoreAdminSessionMysql = typeof meshcoreAdminSessionsMysql.$inferSelect;
