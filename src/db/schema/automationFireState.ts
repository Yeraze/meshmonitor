/**
 * Drizzle schema for Automation Engine fire state (cooldown + rate limit).
 *
 * The engine's cooldown (`cooldownSeconds` / `cooldownScope`) and rate limit
 * (`rateLimit: { maxActions, windowSeconds }`) used to live only in memory, so
 * a restart re-armed every rule. This table keeps that state on disk:
 *
 *  - kind `cooldown`: one row per (automationId, cooldown key). `scopeKey` is
 *    the key `cooldownKeyFor()` returns ('' = automation-wide, a node, or
 *    `source:node`); `firedAt` is the last fire (ms).
 *  - kind `rate`: one row per automation (`scopeKey` = ''). `events` is a JSON
 *    array of the fire times (ms) still inside the window; `firedAt` is the
 *    newest of them.
 *
 * GLOBAL, no sourceId: automations are global (CLAUDE.md exception 3).
 */
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint, uniqueIndex as myUniqueIndex } from 'drizzle-orm/mysql-core';

// SQLite
export const automationFireStateSqlite = sqliteTable('automation_fire_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  automationId: text('automationId').notNull(),
  kind: text('kind').notNull(),
  scopeKey: text('scopeKey').notNull(),
  firedAt: integer('firedAt').notNull(),
  events: text('events'),
}, (t) => ({
  uniq: uniqueIndex('afs_automation_kind_key_idx').on(t.automationId, t.kind, t.scopeKey),
}));

// PostgreSQL
export const automationFireStatePostgres = pgTable('automation_fire_state', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  automationId: pgText('automationId').notNull(),
  kind: pgText('kind').notNull(),
  scopeKey: pgText('scopeKey').notNull(),
  firedAt: pgBigint('firedAt', { mode: 'number' }).notNull(),
  events: pgText('events'),
}, (t) => ({
  uniq: pgUniqueIndex('afs_automation_kind_key_idx').on(t.automationId, t.kind, t.scopeKey),
}));

// MySQL
export const automationFireStateMysql = mysqlTable('automation_fire_state', {
  id: myInt('id').primaryKey().autoincrement(),
  automationId: myVarchar('automationId', { length: 36 }).notNull(),
  kind: myVarchar('kind', { length: 16 }).notNull(),
  scopeKey: myVarchar('scopeKey', { length: 191 }).notNull(),
  firedAt: myBigint('firedAt', { mode: 'number' }).notNull(),
  events: myText('events'),
}, (t) => ({
  uniq: myUniqueIndex('afs_automation_kind_key_idx').on(t.automationId, t.kind, t.scopeKey),
}));

export type AutomationFireStateSqlite = typeof automationFireStateSqlite.$inferSelect;
export type AutomationFireStatePostgres = typeof automationFireStatePostgres.$inferSelect;
export type AutomationFireStateMysql = typeof automationFireStateMysql.$inferSelect;
