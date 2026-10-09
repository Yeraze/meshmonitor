/**
 * Drizzle schema for `pki_exchange_state` (issue #5691, "Reliable PKI").
 *
 * One row per (source, remote node): did the last PKI-encrypted exchange
 * MeshMonitor started with that node get an answer?
 *
 *   - `state` — `successful` | `pending` | `failed`. A send moves the row to
 *     `pending` only when it asks for something back (`want_ack` or
 *     `want_response`); the reply or ack moves it to `successful`; an explicit
 *     "cannot decrypt" routing error, a local MAX_RETRANSMIT, or the exchange
 *     deadline passing moves it to `failed`. A fire-and-forget send leaves it
 *     alone.
 *   - `lastPrimedAt` — when a priming NodeInfo last went to this node from this
 *     source (or when the radio's own firmware sent one after a
 *     PKI_UNKNOWN_PUBKEY NAK). This is the hourly safety timer, so it lives here
 *     in the database: a restart or a settings save cannot reset it.
 *
 * PER-SOURCE — every row carries a `sourceId`. It is a side table rather than
 * columns on `nodes` so a node purge (key repair, "purge nodes") cannot wipe
 * the hourly timer and reopen the window. Does not touch the neighbouring
 * `nodes.lastPKIPacket` / `keyMismatchDetected` fields.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const pkiExchangeStateSqlite = sqliteTable('pki_exchange_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  nodeNum: integer('nodeNum').notNull(),
  state: text('state').notNull(),
  stateChangedAt: integer('stateChangedAt').notNull(),
  lastSuccessAt: integer('lastSuccessAt'),
  failingSince: integer('failingSince'),
  lastFailureReason: text('lastFailureReason'),
  lastPrimedAt: integer('lastPrimedAt'),
  updatedAt: integer('updatedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const pkiExchangeStatePostgres = pgTable('pki_exchange_state', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  // nodeNum is an unsigned 32-bit value: BIGINT, not the signed 32-bit INTEGER.
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  state: pgText('state').notNull(),
  stateChangedAt: pgBigint('stateChangedAt', { mode: 'number' }).notNull(),
  lastSuccessAt: pgBigint('lastSuccessAt', { mode: 'number' }),
  failingSince: pgBigint('failingSince', { mode: 'number' }),
  lastFailureReason: pgText('lastFailureReason'),
  lastPrimedAt: pgBigint('lastPrimedAt', { mode: 'number' }),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const pkiExchangeStateMysql = mysqlTable('pki_exchange_state', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  state: myVarchar('state', { length: 16 }).notNull(),
  stateChangedAt: myBigint('stateChangedAt', { mode: 'number' }).notNull(),
  lastSuccessAt: myBigint('lastSuccessAt', { mode: 'number' }),
  failingSince: myBigint('failingSince', { mode: 'number' }),
  lastFailureReason: myVarchar('lastFailureReason', { length: 32 }),
  lastPrimedAt: myBigint('lastPrimedAt', { mode: 'number' }),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type PkiExchangeStateSqlite = typeof pkiExchangeStateSqlite.$inferSelect;
export type PkiExchangeStatePostgres = typeof pkiExchangeStatePostgres.$inferSelect;
export type PkiExchangeStateMysql = typeof pkiExchangeStateMysql.$inferSelect;
