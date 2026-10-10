/**
 * Drizzle schema for `meshcore_hop_snr` (issue #5722).
 *
 * One row per hop of a MeshCore TRACE the source's companion radio heard: the
 * SNR at which the hop's RECEIVER heard its SENDER. It is directional — "A
 * heard B at X dB" says nothing about how B hears A.
 *
 * A trace's payload carries path hashes (1 or 2 bytes of a public key), not
 * keys. A hash that matches exactly one known contact is stored with that
 * contact's key; otherwise the key is null and `*Candidates` says how many
 * contacts shared the hash (0 = unknown, >1 = ambiguous). Nothing is guessed.
 *
 * `initiated` is 1 when MeshMonitor sent the trace (its reply), 0 when the
 * radio only overheard it. For an overheard trace the first hop's sender (the
 * originator) is not on the wire, so its key and hash are both null.
 *
 * PER-SOURCE — every row carries a `sourceId`; each source keeps its own
 * reception of a trace.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, integer as pgInteger, boolean as pgBoolean, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, boolean as myBoolean, index as myIndex } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreHopSnrSqlite = sqliteTable('meshcore_hop_snr', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  traceTag: integer('traceTag').notNull(),
  authCode: integer('authCode').notNull(),
  hopIndex: integer('hopIndex').notNull(),
  hopCount: integer('hopCount').notNull(),
  hashBytes: integer('hashBytes').notNull(),
  senderPublicKey: text('senderPublicKey'),
  senderHash: text('senderHash'),
  senderCandidates: integer('senderCandidates').notNull(),
  receiverPublicKey: text('receiverPublicKey'),
  receiverHash: text('receiverHash'),
  receiverCandidates: integer('receiverCandidates').notNull(),
  snrQuarterDb: integer('snrQuarterDb').notNull(),
  initiated: integer('initiated', { mode: 'boolean' }).notNull(),
  timestamp: integer('timestamp').notNull(),
}, (t) => ({
  linkIdx: index('meshcore_hop_snr_link_idx').on(t.sourceId, t.receiverPublicKey, t.senderPublicKey, t.timestamp),
  timeIdx: index('meshcore_hop_snr_time_idx').on(t.sourceId, t.timestamp),
}));

// ============ PostgreSQL Schema ============

export const meshcoreHopSnrPostgres = pgTable('meshcore_hop_snr', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  // Unsigned 32-bit values: BIGINT, not the signed 32-bit INTEGER.
  traceTag: pgBigint('traceTag', { mode: 'number' }).notNull(),
  authCode: pgBigint('authCode', { mode: 'number' }).notNull(),
  hopIndex: pgInteger('hopIndex').notNull(),
  hopCount: pgInteger('hopCount').notNull(),
  hashBytes: pgInteger('hashBytes').notNull(),
  senderPublicKey: pgText('senderPublicKey'),
  senderHash: pgText('senderHash'),
  senderCandidates: pgInteger('senderCandidates').notNull(),
  receiverPublicKey: pgText('receiverPublicKey'),
  receiverHash: pgText('receiverHash'),
  receiverCandidates: pgInteger('receiverCandidates').notNull(),
  snrQuarterDb: pgInteger('snrQuarterDb').notNull(),
  initiated: pgBoolean('initiated').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
}, (t) => ({
  linkIdx: pgIndex('meshcore_hop_snr_link_idx').on(t.sourceId, t.receiverPublicKey, t.senderPublicKey, t.timestamp),
  timeIdx: pgIndex('meshcore_hop_snr_time_idx').on(t.sourceId, t.timestamp),
}));

// ============ MySQL Schema ============

export const meshcoreHopSnrMysql = mysqlTable('meshcore_hop_snr', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  traceTag: myBigint('traceTag', { mode: 'number' }).notNull(),
  authCode: myBigint('authCode', { mode: 'number' }).notNull(),
  hopIndex: myInt('hopIndex').notNull(),
  hopCount: myInt('hopCount').notNull(),
  hashBytes: myInt('hashBytes').notNull(),
  senderPublicKey: myVarchar('senderPublicKey', { length: 64 }),
  senderHash: myVarchar('senderHash', { length: 8 }),
  senderCandidates: myInt('senderCandidates').notNull(),
  receiverPublicKey: myVarchar('receiverPublicKey', { length: 64 }),
  receiverHash: myVarchar('receiverHash', { length: 8 }),
  receiverCandidates: myInt('receiverCandidates').notNull(),
  snrQuarterDb: myInt('snrQuarterDb').notNull(),
  initiated: myBoolean('initiated').notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
}, (t) => ({
  linkIdx: myIndex('meshcore_hop_snr_link_idx').on(t.sourceId, t.receiverPublicKey, t.senderPublicKey, t.timestamp),
  timeIdx: myIndex('meshcore_hop_snr_time_idx').on(t.sourceId, t.timestamp),
}));

// ============ Type Inference ============

export type MeshcoreHopSnrSqlite = typeof meshcoreHopSnrSqlite.$inferSelect;
export type MeshcoreHopSnrPostgres = typeof meshcoreHopSnrPostgres.$inferSelect;
export type MeshcoreHopSnrMysql = typeof meshcoreHopSnrMysql.$inferSelect;
