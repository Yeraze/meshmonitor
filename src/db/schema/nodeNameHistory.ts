/**
 * Drizzle schema for `node_name_history` (issue #5862).
 *
 * One row per rename a source saw. `protocol` says how to read `nodeKey`:
 * 'meshtastic' → decimal nodeNum, 'meshcore' → public key hex. MeshCore nodes
 * have a single name, stored in the long-name columns (short names stay null).
 *
 * PER-SOURCE — every row carries a `sourceId`. Node Details merges the rows
 * from every source the viewer may see the node on.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, index as myIndex } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const nodeNameHistorySqlite = sqliteTable('node_name_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  protocol: text('protocol').notNull(),
  nodeKey: text('nodeKey').notNull(),
  oldLongName: text('oldLongName'),
  newLongName: text('newLongName'),
  oldShortName: text('oldShortName'),
  newShortName: text('newShortName'),
  changedAt: integer('changedAt').notNull(),
}, (t) => ({
  nodeIdx: index('node_name_history_node_idx').on(t.protocol, t.nodeKey, t.sourceId, t.changedAt),
  sourceIdx: index('node_name_history_source_idx').on(t.sourceId),
}));

// ============ PostgreSQL Schema ============

export const nodeNameHistoryPostgres = pgTable('node_name_history', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  protocol: pgText('protocol').notNull(),
  nodeKey: pgText('nodeKey').notNull(),
  oldLongName: pgText('oldLongName'),
  newLongName: pgText('newLongName'),
  oldShortName: pgText('oldShortName'),
  newShortName: pgText('newShortName'),
  changedAt: pgBigint('changedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  nodeIdx: pgIndex('node_name_history_node_idx').on(t.protocol, t.nodeKey, t.sourceId, t.changedAt),
  sourceIdx: pgIndex('node_name_history_source_idx').on(t.sourceId),
}));

// ============ MySQL Schema ============

export const nodeNameHistoryMysql = mysqlTable('node_name_history', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  protocol: myVarchar('protocol', { length: 16 }).notNull(),
  nodeKey: myVarchar('nodeKey', { length: 64 }).notNull(),
  oldLongName: myVarchar('oldLongName', { length: 255 }),
  newLongName: myVarchar('newLongName', { length: 255 }),
  oldShortName: myVarchar('oldShortName', { length: 32 }),
  newShortName: myVarchar('newShortName', { length: 32 }),
  changedAt: myBigint('changedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  nodeIdx: myIndex('node_name_history_node_idx').on(t.protocol, t.nodeKey, t.sourceId, t.changedAt),
  sourceIdx: myIndex('node_name_history_source_idx').on(t.sourceId),
}));

// ============ Type Inference ============

export type NodeNameHistorySqlite = typeof nodeNameHistorySqlite.$inferSelect;
export type NodeNameHistoryPostgres = typeof nodeNameHistoryPostgres.$inferSelect;
export type NodeNameHistoryMysql = typeof nodeNameHistoryMysql.$inferSelect;
