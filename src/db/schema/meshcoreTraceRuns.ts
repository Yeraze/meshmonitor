/**
 * Drizzle schema for `meshcore_trace_runs` (issue #6276, P14 WP4).
 *
 * One row per MeshCore trace MeshMonitor SENT (an attempt log). `meshcore_hop_snr`
 * keeps only traces that came back; this table also records the ones that timed
 * out or failed, and the target contact, which the hop rows do not carry. The
 * Traceroute Explorer joins the two by `(sourceId, traceTag, authCode)`.
 *
 * The tag is chosen by the manager and handed to the backend, so a row can be
 * written before the reply arrives. `pending` rows older than the longest
 * possible wait are swept to `timeout` on startup.
 *
 * PER-SOURCE — every row carries a `sourceId`.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, integer as pgInteger, boolean as pgBoolean, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, boolean as myBoolean, index as myIndex } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreTraceRunsSqlite = sqliteTable('meshcore_trace_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  traceTag: integer('traceTag').notNull(),
  authCode: integer('authCode').notNull(),
  targetPublicKey: text('targetPublicKey'),
  pathHex: text('pathHex').notNull(),
  hashBytes: integer('hashBytes').notNull(),
  autoReturn: integer('autoReturn', { mode: 'boolean' }).notNull(),
  origin: text('origin').notNull(),
  status: text('status').notNull(),
  sentAt: integer('sentAt').notNull(),
  completedAt: integer('completedAt'),
}, (t) => ({
  timeIdx: index('meshcore_trace_runs_time_idx').on(t.sourceId, t.sentAt),
  tagIdx: index('meshcore_trace_runs_tag_idx').on(t.sourceId, t.traceTag, t.authCode),
}));

// ============ PostgreSQL Schema ============

export const meshcoreTraceRunsPostgres = pgTable('meshcore_trace_runs', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  // Unsigned 32-bit values: BIGINT, not the signed 32-bit INTEGER.
  traceTag: pgBigint('traceTag', { mode: 'number' }).notNull(),
  authCode: pgBigint('authCode', { mode: 'number' }).notNull(),
  targetPublicKey: pgText('targetPublicKey'),
  pathHex: pgText('pathHex').notNull(),
  hashBytes: pgInteger('hashBytes').notNull(),
  autoReturn: pgBoolean('autoReturn').notNull(),
  origin: pgText('origin').notNull(),
  status: pgText('status').notNull(),
  sentAt: pgBigint('sentAt', { mode: 'number' }).notNull(),
  completedAt: pgBigint('completedAt', { mode: 'number' }),
}, (t) => ({
  timeIdx: pgIndex('meshcore_trace_runs_time_idx').on(t.sourceId, t.sentAt),
  tagIdx: pgIndex('meshcore_trace_runs_tag_idx').on(t.sourceId, t.traceTag, t.authCode),
}));

// ============ MySQL Schema ============

export const meshcoreTraceRunsMysql = mysqlTable('meshcore_trace_runs', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  traceTag: myBigint('traceTag', { mode: 'number' }).notNull(),
  authCode: myBigint('authCode', { mode: 'number' }).notNull(),
  targetPublicKey: myVarchar('targetPublicKey', { length: 64 }),
  // Up to 2 hash bytes per hop x ~64 hops, plus headroom.
  pathHex: myVarchar('pathHex', { length: 512 }).notNull(),
  hashBytes: myInt('hashBytes').notNull(),
  autoReturn: myBoolean('autoReturn').notNull(),
  origin: myVarchar('origin', { length: 16 }).notNull(),
  status: myVarchar('status', { length: 16 }).notNull(),
  sentAt: myBigint('sentAt', { mode: 'number' }).notNull(),
  completedAt: myBigint('completedAt', { mode: 'number' }),
}, (t) => ({
  timeIdx: myIndex('meshcore_trace_runs_time_idx').on(t.sourceId, t.sentAt),
  tagIdx: myIndex('meshcore_trace_runs_tag_idx').on(t.sourceId, t.traceTag, t.authCode),
}));
