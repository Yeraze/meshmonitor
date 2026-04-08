/**
 * Drizzle schema definition for node admin permissions table
 * Allows admins to grant non-admin users remote admin access to specific nodes.
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, integer, unique } from 'drizzle-orm/sqlite-core';
import { pgTable, integer as pgInteger, bigint as pgBigint, serial as pgSerial, unique as pgUnique } from 'drizzle-orm/pg-core';
import { mysqlTable, int as myInt, bigint as myBigint, serial as mySerial, unique as myUnique } from 'drizzle-orm/mysql-core';
import { usersSqlite, usersPostgres, usersMysql } from './auth.js';

// ============ SQLite ============

export const nodeAdminPermissionsSqlite = sqliteTable('node_admin_permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  nodeNum: integer('node_num').notNull(),
  grantedBy: integer('granted_by').references(() => usersSqlite.id, { onDelete: 'set null' }),
  grantedAt: integer('granted_at').notNull(),
}, (table) => ({
  uniqueUserNode: unique().on(table.userId, table.nodeNum),
}));

// ============ PostgreSQL ============

export const nodeAdminPermissionsPostgres = pgTable('node_admin_permissions', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  grantedBy: pgInteger('grantedBy').references(() => usersPostgres.id, { onDelete: 'set null' }),
  grantedAt: pgBigint('grantedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueUserNode: pgUnique().on(table.userId, table.nodeNum),
}));

// ============ MySQL ============

export const nodeAdminPermissionsMysql = mysqlTable('node_admin_permissions', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  grantedBy: myInt('grantedBy').references(() => usersMysql.id, { onDelete: 'set null' }),
  grantedAt: myBigint('grantedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  uniqueUserNode: myUnique().on(table.userId, table.nodeNum),
}));

// Type inference
export type NodeAdminPermissionSqlite = typeof nodeAdminPermissionsSqlite.$inferSelect;
export type NewNodeAdminPermissionSqlite = typeof nodeAdminPermissionsSqlite.$inferInsert;
export type NodeAdminPermissionPostgres = typeof nodeAdminPermissionsPostgres.$inferSelect;
export type NewNodeAdminPermissionPostgres = typeof nodeAdminPermissionsPostgres.$inferInsert;
export type NodeAdminPermissionMysql = typeof nodeAdminPermissionsMysql.$inferSelect;
export type NewNodeAdminPermissionMysql = typeof nodeAdminPermissionsMysql.$inferInsert;
