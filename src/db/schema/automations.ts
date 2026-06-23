/**
 * Drizzle schema for the Automation Engine tables (#3653).
 * Supports SQLite, PostgreSQL, and MySQL.
 *
 * `automations` is GLOBAL by design (no sourceId) — see migration 098.
 * `automation_runs` is the execution log (Phase 1a) and stateful run store (Phase 1b).
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ===================== automations =====================

// SQLite
export const automationsSqlite = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  config: text('config').notNull().default('{}'),
  createdByUserId: integer('createdByUserId'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const automationsPostgres = pgTable('automations', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  description: pgText('description'),
  enabled: pgBoolean('enabled').notNull().default(false),
  config: pgText('config').notNull().default('{}'),
  createdByUserId: pgInteger('createdByUserId'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const automationsMysql = mysqlTable('automations', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  description: myText('description'),
  enabled: myBoolean('enabled').notNull().default(false),
  config: myText('config').notNull(),
  createdByUserId: myInt('createdByUserId'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ===================== automation_runs =====================

// SQLite
export const automationRunsSqlite = sqliteTable('automation_runs', {
  id: text('id').primaryKey(),
  automationId: text('automationId').notNull(),
  sourceId: text('sourceId'),
  status: text('status').notNull().default('completed'),
  state: text('state'),
  triggerEvent: text('triggerEvent'),
  log: text('log'),
  startedAt: integer('startedAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const automationRunsPostgres = pgTable('automation_runs', {
  id: pgText('id').primaryKey(),
  automationId: pgText('automationId').notNull(),
  sourceId: pgText('sourceId'),
  status: pgText('status').notNull().default('completed'),
  state: pgText('state'),
  triggerEvent: pgText('triggerEvent'),
  log: pgText('log'),
  startedAt: pgBigint('startedAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const automationRunsMysql = mysqlTable('automation_runs', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  automationId: myVarchar('automationId', { length: 36 }).notNull(),
  sourceId: myVarchar('sourceId', { length: 255 }),
  status: myVarchar('status', { length: 32 }).notNull().default('completed'),
  state: myText('state'),
  triggerEvent: myText('triggerEvent'),
  log: myText('log'),
  startedAt: myBigint('startedAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type AutomationSqlite = typeof automationsSqlite.$inferSelect;
export type NewAutomationSqlite = typeof automationsSqlite.$inferInsert;
export type AutomationPostgres = typeof automationsPostgres.$inferSelect;
export type AutomationMysql = typeof automationsMysql.$inferSelect;

export type AutomationRunSqlite = typeof automationRunsSqlite.$inferSelect;
export type NewAutomationRunSqlite = typeof automationRunsSqlite.$inferInsert;
export type AutomationRunPostgres = typeof automationRunsPostgres.$inferSelect;
export type AutomationRunMysql = typeof automationRunsMysql.$inferSelect;
