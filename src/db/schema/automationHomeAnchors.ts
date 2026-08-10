/**
 * Drizzle schema for Automation Engine home anchors (left-home / tamper triggers).
 *
 * One row per (automationId, nodeNum): the lat/lon captured on first sighting so
 * `trigger.leftHome` survives MeshMonitor restarts without silently re-homing a
 * stolen node on the next GPS fix. GLOBAL — no sourceId (automations are global).
 */
import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, doublePrecision, bigint as pgBigint, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint, uniqueIndex as myUniqueIndex } from 'drizzle-orm/mysql-core';

// SQLite
export const automationHomeAnchorsSqlite = sqliteTable('automation_home_anchors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  automationId: text('automationId').notNull(),
  nodeNum: integer('nodeNum').notNull(),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  setAt: integer('setAt').notNull(),
}, (t) => ({
  uniq: uniqueIndex('aha_automation_node_idx').on(t.automationId, t.nodeNum),
}));

// PostgreSQL
export const automationHomeAnchorsPostgres = pgTable('automation_home_anchors', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  automationId: pgText('automationId').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  latitude: doublePrecision('latitude').notNull(),
  longitude: doublePrecision('longitude').notNull(),
  setAt: pgBigint('setAt', { mode: 'number' }).notNull(),
}, (t) => ({
  uniq: pgUniqueIndex('aha_automation_node_idx').on(t.automationId, t.nodeNum),
}));

// MySQL
export const automationHomeAnchorsMysql = mysqlTable('automation_home_anchors', {
  id: myInt('id').primaryKey().autoincrement(),
  automationId: myVarchar('automationId', { length: 36 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  setAt: myBigint('setAt', { mode: 'number' }).notNull(),
}, (t) => ({
  uniq: myUniqueIndex('aha_automation_node_idx').on(t.automationId, t.nodeNum),
}));

export type AutomationHomeAnchorSqlite = typeof automationHomeAnchorsSqlite.$inferSelect;
export type AutomationHomeAnchorPostgres = typeof automationHomeAnchorsPostgres.$inferSelect;
export type AutomationHomeAnchorMysql = typeof automationHomeAnchorsMysql.$inferSelect;
