/**
 * Drizzle schema for MeshCore client-side Ignore / Block (#5408).
 *
 * MeshCore firmware has no block or mute, so the policy lives here. Two
 * PER-SOURCE tables:
 *
 * - `meshcore_ignored_nodes` — one row per (sourceId, publicKey). `name` is the
 *   advert-name snapshot, refreshed when a newer name is seen. It is used to
 *   match channel messages (which carry only a name) and keeps the Settings
 *   list readable after the `meshcore_nodes` row is pruned: this table is the
 *   authority, independent of `meshcore_nodes`.
 * - `meshcore_message_filters` — text rules (exact / wildcard / regex) over the
 *   sender name, the body, or both.
 *
 * Both carry `hitCount` + `lastHitAt`; blocked messages are never stored, so
 * the counter is the only trace they leave.
 *
 * The FK to sources(id) ON DELETE CASCADE is declared in the migration DDL
 * (migration 182), matching the aircraft_flight_matches convention.
 */
import { sqliteTable, text, integer, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint as pgBigint,
  boolean as pgBoolean,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  int as myInt,
  bigint as myBigint,
  boolean as myBoolean,
  primaryKey as myPrimaryKey,
} from 'drizzle-orm/mysql-core';

// ============ IGNORED NODES ============

export const meshcoreIgnoredNodesSqlite = sqliteTable('meshcore_ignored_nodes', {
  sourceId: text('sourceId').notNull(),
  /** 64-hex public key, lowercase. */
  publicKey: text('publicKey').notNull(),
  name: text('name'),
  /** 'ignore' | 'block' */
  mode: text('mode').notNull().default('ignore'),
  createdAt: integer('createdAt').notNull(),
  createdBy: integer('createdBy'),
  hitCount: integer('hitCount').notNull().default(0),
  lastHitAt: integer('lastHitAt'),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

export const meshcoreIgnoredNodesPostgres = pgTable('meshcore_ignored_nodes', {
  sourceId: pgText('sourceId').notNull(),
  publicKey: pgText('publicKey').notNull(),
  name: pgText('name'),
  mode: pgText('mode').notNull().default('ignore'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  createdBy: pgInteger('createdBy'),
  hitCount: pgInteger('hitCount').notNull().default(0),
  lastHitAt: pgBigint('lastHitAt', { mode: 'number' }),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

export const meshcoreIgnoredNodesMysql = mysqlTable('meshcore_ignored_nodes', {
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }).notNull(),
  name: myVarchar('name', { length: 255 }),
  mode: myVarchar('mode', { length: 8 }).notNull().default('ignore'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  createdBy: myInt('createdBy'),
  hitCount: myInt('hitCount').notNull().default(0),
  lastHitAt: myBigint('lastHitAt', { mode: 'number' }),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

// ============ MESSAGE FILTERS ============

export const meshcoreMessageFiltersSqlite = sqliteTable('meshcore_message_filters', {
  /** UUID. */
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  /** 'ignore' | 'block' */
  mode: text('mode').notNull().default('ignore'),
  /** 'exact' | 'wildcard' | 'regex' */
  matchType: text('matchType').notNull(),
  pattern: text('pattern').notNull(),
  caseSensitive: integer('caseSensitive', { mode: 'boolean' }).notNull().default(false),
  /** 'name' | 'body' | 'both' */
  fields: text('fields').notNull().default('both'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('createdAt').notNull(),
  createdBy: integer('createdBy'),
  hitCount: integer('hitCount').notNull().default(0),
  lastHitAt: integer('lastHitAt'),
});

export const meshcoreMessageFiltersPostgres = pgTable('meshcore_message_filters', {
  id: pgText('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  mode: pgText('mode').notNull().default('ignore'),
  matchType: pgText('matchType').notNull(),
  pattern: pgText('pattern').notNull(),
  caseSensitive: pgBoolean('caseSensitive').notNull().default(false),
  fields: pgText('fields').notNull().default('both'),
  enabled: pgBoolean('enabled').notNull().default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  createdBy: pgInteger('createdBy'),
  hitCount: pgInteger('hitCount').notNull().default(0),
  lastHitAt: pgBigint('lastHitAt', { mode: 'number' }),
});

export const meshcoreMessageFiltersMysql = mysqlTable('meshcore_message_filters', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  mode: myVarchar('mode', { length: 8 }).notNull().default('ignore'),
  matchType: myVarchar('matchType', { length: 16 }).notNull(),
  pattern: myVarchar('pattern', { length: 512 }).notNull(),
  caseSensitive: myBoolean('caseSensitive').notNull().default(false),
  fields: myVarchar('fields', { length: 8 }).notNull().default('both'),
  enabled: myBoolean('enabled').notNull().default(true),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  createdBy: myInt('createdBy'),
  hitCount: myInt('hitCount').notNull().default(0),
  lastHitAt: myBigint('lastHitAt', { mode: 'number' }),
});

export type MeshcoreIgnoredNodeSqlite = typeof meshcoreIgnoredNodesSqlite.$inferSelect;
export type MeshcoreMessageFilterSqlite = typeof meshcoreMessageFiltersSqlite.$inferSelect;
