/**
 * Drizzle schema for the Automation Engine user-defined variables (#3653, §5.2).
 * Supports SQLite, PostgreSQL, and MySQL.
 *
 * `automation_variables` — global definitions (name/type/scope/readonly/config).
 * `automation_variable_values` — per-scope values (scopeKey + flag expiresAt).
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ===================== automation_variables (definitions) =====================

// SQLite
export const automationVariablesSqlite = sqliteTable('automation_variables', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  type: text('type').notNull(),
  scope: text('scope').notNull(),
  readonly: integer('readonly', { mode: 'boolean' }).notNull().default(false),
  config: text('config').notNull().default('{}'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const automationVariablesPostgres = pgTable('automation_variables', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull().unique(),
  description: pgText('description'),
  type: pgText('type').notNull(),
  scope: pgText('scope').notNull(),
  readonly: pgBoolean('readonly').notNull().default(false),
  config: pgText('config').notNull().default('{}'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const automationVariablesMysql = mysqlTable('automation_variables', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull().unique(),
  description: myText('description'),
  type: myVarchar('type', { length: 32 }).notNull(),
  scope: myVarchar('scope', { length: 32 }).notNull(),
  readonly: myBoolean('readonly').notNull().default(false),
  config: myText('config').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ===================== automation_variable_values =====================

// SQLite
export const automationVariableValuesSqlite = sqliteTable('automation_variable_values', {
  id: text('id').primaryKey(),
  variableId: text('variableId').notNull(),
  scopeKey: text('scopeKey').notNull(),
  value: text('value'),
  expiresAt: integer('expiresAt'),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const automationVariableValuesPostgres = pgTable('automation_variable_values', {
  id: pgText('id').primaryKey(),
  variableId: pgText('variableId').notNull(),
  scopeKey: pgText('scopeKey').notNull(),
  value: pgText('value'),
  expiresAt: pgBigint('expiresAt', { mode: 'number' }),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const automationVariableValuesMysql = mysqlTable('automation_variable_values', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  variableId: myVarchar('variableId', { length: 36 }).notNull(),
  scopeKey: myVarchar('scopeKey', { length: 255 }).notNull(),
  value: myText('value'),
  expiresAt: myBigint('expiresAt', { mode: 'number' }),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type AutomationVariableSqlite = typeof automationVariablesSqlite.$inferSelect;
export type NewAutomationVariableSqlite = typeof automationVariablesSqlite.$inferInsert;
export type AutomationVariableValueSqlite = typeof automationVariableValuesSqlite.$inferSelect;
export type NewAutomationVariableValueSqlite = typeof automationVariableValuesSqlite.$inferInsert;
