/**
 * Drizzle schema for `meshcore_cli_history` (issue #5892).
 *
 * One row per MeshCore CLI command a person issued through MeshMonitor.
 * PER-SOURCE — every row carries a `sourceId`. `command`, `reply` and `error`
 * are stored redacted (see `src/server/utils/meshcoreCliRedact.ts`).
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, integer as pgInteger, serial as pgSerial, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint, index as myIndex } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreCliHistorySqlite = sqliteTable('meshcore_cli_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  timestamp: integer('timestamp').notNull(),
  targetKind: text('targetKind').notNull(),
  targetPublicKey: text('targetPublicKey'),
  targetName: text('targetName'),
  origin: text('origin').notNull(),
  userId: integer('userId'),
  username: text('username'),
  command: text('command').notNull(),
  outcome: text('outcome').notNull(),
  reply: text('reply'),
  error: text('error'),
  elapsedMs: integer('elapsedMs'),
  ipAddress: text('ipAddress'),
}, (t) => ({
  sourceTimeIdx: index('meshcore_cli_history_source_time_idx').on(t.sourceId, t.timestamp),
  timeIdx: index('meshcore_cli_history_time_idx').on(t.timestamp),
}));

// ============ PostgreSQL Schema ============

export const meshcoreCliHistoryPostgres = pgTable('meshcore_cli_history', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  targetKind: pgText('targetKind').notNull(),
  targetPublicKey: pgText('targetPublicKey'),
  targetName: pgText('targetName'),
  origin: pgText('origin').notNull(),
  userId: pgInteger('userId'),
  username: pgText('username'),
  command: pgText('command').notNull(),
  outcome: pgText('outcome').notNull(),
  reply: pgText('reply'),
  error: pgText('error'),
  elapsedMs: pgInteger('elapsedMs'),
  ipAddress: pgText('ipAddress'),
}, (t) => ({
  sourceTimeIdx: pgIndex('meshcore_cli_history_source_time_idx').on(t.sourceId, t.timestamp),
  timeIdx: pgIndex('meshcore_cli_history_time_idx').on(t.timestamp),
}));

// ============ MySQL Schema ============

export const meshcoreCliHistoryMysql = mysqlTable('meshcore_cli_history', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  targetKind: myVarchar('targetKind', { length: 16 }).notNull(),
  targetPublicKey: myVarchar('targetPublicKey', { length: 64 }),
  targetName: myVarchar('targetName', { length: 255 }),
  origin: myVarchar('origin', { length: 16 }).notNull(),
  userId: myInt('userId'),
  username: myVarchar('username', { length: 255 }),
  command: myText('command').notNull(),
  outcome: myVarchar('outcome', { length: 16 }).notNull(),
  reply: myText('reply'),
  error: myText('error'),
  elapsedMs: myInt('elapsedMs'),
  ipAddress: myVarchar('ipAddress', { length: 64 }),
}, (t) => ({
  sourceTimeIdx: myIndex('meshcore_cli_history_source_time_idx').on(t.sourceId, t.timestamp),
  timeIdx: myIndex('meshcore_cli_history_time_idx').on(t.timestamp),
}));

// ============ Type Inference ============

export type MeshCoreCliHistorySqlite = typeof meshcoreCliHistorySqlite.$inferSelect;
export type MeshCoreCliHistoryPostgres = typeof meshcoreCliHistoryPostgres.$inferSelect;
export type MeshCoreCliHistoryMysql = typeof meshcoreCliHistoryMysql.$inferSelect;
