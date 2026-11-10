/**
 * Drizzle schema for `meshcore_neighbor_watch` (issue #6274, migration 229).
 *
 * A per-reporter ledger of the neighbours a MeshCore repeater's table has
 * listed. `meshcore_neighbor_info` is replaced wholesale on every poll, so it
 * cannot say when a neighbour first appeared; this table can. `state` is
 * `baseline` (listed when the reporter was first evaluated), `pending` (a
 * newcomer being watched) or `confirmed` (seen long enough to stop counting).
 *
 * PER-SOURCE: every row carries a `sourceId`.
 */
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial, uniqueIndex as pgUniqueIndex, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint, serial as mySerial, uniqueIndex as myUniqueIndex, index as myIndex } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreNeighborWatchSqlite = sqliteTable(
  'meshcore_neighbor_watch',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: text('sourceId').notNull(),
    reporterPublicKey: text('reporterPublicKey').notNull(),
    neighborPublicKey: text('neighborPublicKey').notNull(),
    state: text('state').notNull(),
    firstSeenAt: integer('firstSeenAt').notNull(), // ms
    lastHeardAt: integer('lastHeardAt').notNull(), // ms
    lastSnr: real('lastSnr'),
    sightings: integer('sightings').notNull().default(0),
    updatedAt: integer('updatedAt').notNull(), // ms
  },
  (t) => ({
    uniq: uniqueIndex('meshcore_neighbor_watch_uniq').on(t.sourceId, t.reporterPublicKey, t.neighborPublicKey),
    sourceIdx: index('meshcore_neighbor_watch_source_idx').on(t.sourceId),
  }),
);

// ============ PostgreSQL Schema ============

export const meshcoreNeighborWatchPostgres = pgTable(
  'meshcore_neighbor_watch',
  {
    id: pgSerial('id').primaryKey(),
    sourceId: pgText('sourceId').notNull(),
    reporterPublicKey: pgText('reporterPublicKey').notNull(),
    neighborPublicKey: pgText('neighborPublicKey').notNull(),
    state: pgText('state').notNull(),
    firstSeenAt: pgBigint('firstSeenAt', { mode: 'number' }).notNull(),
    lastHeardAt: pgBigint('lastHeardAt', { mode: 'number' }).notNull(),
    lastSnr: pgReal('lastSnr'),
    sightings: pgInteger('sightings').notNull().default(0),
    updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  },
  (t) => ({
    uniq: pgUniqueIndex('meshcore_neighbor_watch_uniq').on(t.sourceId, t.reporterPublicKey, t.neighborPublicKey),
    sourceIdx: pgIndex('meshcore_neighbor_watch_source_idx').on(t.sourceId),
  }),
);

// ============ MySQL Schema ============

export const meshcoreNeighborWatchMysql = mysqlTable(
  'meshcore_neighbor_watch',
  {
    id: mySerial('id').primaryKey(),
    sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
    reporterPublicKey: myVarchar('reporterPublicKey', { length: 64 }).notNull(),
    neighborPublicKey: myVarchar('neighborPublicKey', { length: 64 }).notNull(),
    state: myVarchar('state', { length: 16 }).notNull(),
    firstSeenAt: myBigint('firstSeenAt', { mode: 'number' }).notNull(),
    lastHeardAt: myBigint('lastHeardAt', { mode: 'number' }).notNull(),
    lastSnr: myDouble('lastSnr'),
    sightings: myInt('sightings').notNull().default(0),
    updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  },
  (t) => ({
    uniq: myUniqueIndex('meshcore_neighbor_watch_uniq').on(t.sourceId, t.reporterPublicKey, t.neighborPublicKey),
    sourceIdx: myIndex('meshcore_neighbor_watch_source_idx').on(t.sourceId),
  }),
);
