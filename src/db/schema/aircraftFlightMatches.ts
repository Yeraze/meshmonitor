/**
 * Drizzle schema for `aircraft_flight_matches` (ADS-B flight matching, #5374).
 *
 * One row per (sourceId, nodeNum): the current likely-aircraft flagging
 * ("episode") and the ADS-B lookups spent on it. `lookups` is the DB-backed
 * cap (max 2 per episode), so a restart or a settings save cannot reset it.
 *
 * PER-SOURCE. The FK to sources(id) ON DELETE CASCADE is declared in the
 * migration DDL (migration 180), matching the waypoints convention.
 */
import { sqliteTable, text, integer, real, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint as pgBigint,
  doublePrecision as pgDouble,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  int as myInt,
  bigint as myBigint,
  double as myDouble,
  primaryKey as myPrimaryKey,
} from 'drizzle-orm/mysql-core';

// ============ SQLite ============

export const aircraftFlightMatchesSqlite = sqliteTable('aircraft_flight_matches', {
  sourceId: text('sourceId').notNull(),
  nodeNum: integer('nodeNum').notNull(),
  /** ms; when the flag transition that opened this episode happened. */
  episodeStartedAt: integer('episodeStartedAt').notNull(),
  /** 0–2; lookups used in this episode. */
  lookups: integer('lookups').notNull().default(0),
  /** ms; time of lookup 1. */
  firstLookupAt: integer('firstLookupAt'),
  /** 'none' | 'possible' | 'matched'. */
  status: text('status').notNull().default('none'),
  /** Feed that answered the last lookup that set this status. */
  feed: text('feed'),
  hex: text('hex'),
  callsign: text('callsign'),
  aircraftType: text('aircraftType'),
  registration: text('registration'),
  gsKt: real('gsKt'),
  trackDeg: real('trackDeg'),
  altM: real('altM'),
  distanceKm: real('distanceKm'),
  /** ms; the last lookup that produced this status. */
  matchedAt: integer('matchedAt'),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
}));

// ============ PostgreSQL ============

export const aircraftFlightMatchesPostgres = pgTable('aircraft_flight_matches', {
  sourceId: pgText('sourceId').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  episodeStartedAt: pgBigint('episodeStartedAt', { mode: 'number' }).notNull(),
  lookups: pgInteger('lookups').notNull().default(0),
  firstLookupAt: pgBigint('firstLookupAt', { mode: 'number' }),
  status: pgText('status').notNull().default('none'),
  feed: pgText('feed'),
  hex: pgText('hex'),
  callsign: pgText('callsign'),
  aircraftType: pgText('aircraftType'),
  registration: pgText('registration'),
  gsKt: pgDouble('gsKt'),
  trackDeg: pgDouble('trackDeg'),
  altM: pgDouble('altM'),
  distanceKm: pgDouble('distanceKm'),
  matchedAt: pgBigint('matchedAt', { mode: 'number' }),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
}));

// ============ MySQL ============

export const aircraftFlightMatchesMysql = mysqlTable('aircraft_flight_matches', {
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  episodeStartedAt: myBigint('episodeStartedAt', { mode: 'number' }).notNull(),
  lookups: myInt('lookups').notNull().default(0),
  firstLookupAt: myBigint('firstLookupAt', { mode: 'number' }),
  status: myVarchar('status', { length: 16 }).notNull().default('none'),
  feed: myVarchar('feed', { length: 32 }),
  hex: myVarchar('hex', { length: 16 }),
  callsign: myVarchar('callsign', { length: 32 }),
  aircraftType: myVarchar('aircraftType', { length: 16 }),
  registration: myVarchar('registration', { length: 32 }),
  gsKt: myDouble('gsKt'),
  trackDeg: myDouble('trackDeg'),
  altM: myDouble('altM'),
  distanceKm: myDouble('distanceKm'),
  matchedAt: myBigint('matchedAt', { mode: 'number' }),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
}));

export type AircraftFlightMatchSqlite = typeof aircraftFlightMatchesSqlite.$inferSelect;
export type AircraftFlightMatchPostgres = typeof aircraftFlightMatchesPostgres.$inferSelect;
export type AircraftFlightMatchMysql = typeof aircraftFlightMatchesMysql.$inferSelect;
