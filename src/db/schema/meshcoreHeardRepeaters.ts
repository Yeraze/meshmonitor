/**
 * Drizzle schema for the `meshcore_heard_repeaters` side table (#3700).
 *
 * MeshCore channel (broadcast) messages carry no protocol-level ACK, so there is
 * normally no signal that any repeater relayed an outgoing channel post. We infer
 * one best-effort by self-echo correlation: when a nearby repeater re-floods our
 * own GRP_TXT channel packet, our device hears that re-flood as an inbound OTA
 * packet (`LogRxData` → `ota_packet`) whose relay-hash chain (`path_hops`)
 * names the repeaters that carried it. We attribute those repeater hashes to the
 * most recent matching outgoing channel send within a short window.
 *
 * One row per (message, repeater hash). PER-SOURCE (`sourceId`, scoped) — a row
 * belongs to the source whose device heard the echo. A side table (rather than a
 * JSON column on `meshcore_messages`) keeps the variable-length list normalized,
 * supports cheap per-message aggregation, and avoids read-modify-write races as
 * multiple echoes stream in.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreHeardRepeatersSqlite = sqliteTable('meshcore_heard_repeaters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Owning source (the device that heard the self-echo).
  sourceId: text('sourceId').notNull(),
  // FK-ish to meshcore_messages.id (the outgoing channel message that was relayed).
  messageId: text('messageId').notNull(),
  // Relay hash (hex) of the repeater that re-flooded the packet.
  repeaterHash: text('repeaterHash').notNull(),
  // Resolved repeater contact name (best-effort; null when the hash is unknown).
  repeaterName: text('repeaterName'),
  // Best (max) SNR observed for this repeater across echoes (nullable).
  snr: integer('snr'),
  // When the echo was heard (Unix ms).
  heardAt: integer('heardAt').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcoreHeardRepeatersPostgres = pgTable('meshcore_heard_repeaters', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  messageId: pgText('messageId').notNull(),
  repeaterHash: pgText('repeaterHash').notNull(),
  repeaterName: pgText('repeaterName'),
  snr: pgInteger('snr'),
  heardAt: pgBigint('heardAt', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcoreHeardRepeatersMysql = mysqlTable('meshcore_heard_repeaters', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  messageId: myVarchar('messageId', { length: 64 }).notNull(),
  repeaterHash: myVarchar('repeaterHash', { length: 16 }).notNull(),
  repeaterName: myVarchar('repeaterName', { length: 128 }),
  snr: myInt('snr'),
  heardAt: myBigint('heardAt', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshCoreHeardRepeaterSqlite = typeof meshcoreHeardRepeatersSqlite.$inferSelect;
export type NewMeshCoreHeardRepeaterSqlite = typeof meshcoreHeardRepeatersSqlite.$inferInsert;
export type MeshCoreHeardRepeaterPostgres = typeof meshcoreHeardRepeatersPostgres.$inferSelect;
export type NewMeshCoreHeardRepeaterPostgres = typeof meshcoreHeardRepeatersPostgres.$inferInsert;
export type MeshCoreHeardRepeaterMysql = typeof meshcoreHeardRepeatersMysql.$inferSelect;
export type NewMeshCoreHeardRepeaterMysql = typeof meshcoreHeardRepeatersMysql.$inferInsert;
