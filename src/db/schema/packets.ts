/**
 * Drizzle schema definition for the packet_log table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';

// SQLite schema
export const packetLogSqlite = sqliteTable('packet_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packet_id: integer('packet_id'),
  timestamp: integer('timestamp').notNull(),
  from_node: integer('from_node').notNull(),
  from_node_id: text('from_node_id'),
  from_node_longName: text('from_node_longName'),
  to_node: integer('to_node'),
  to_node_id: text('to_node_id'),
  to_node_longName: text('to_node_longName'),
  channel: integer('channel'),
  portnum: integer('portnum').notNull(),
  portnum_name: text('portnum_name'),
  encrypted: integer('encrypted', { mode: 'boolean' }).notNull(),
  snr: real('snr'),
  rssi: real('rssi'),
  hop_limit: integer('hop_limit'),
  hop_start: integer('hop_start'),
  relay_node: integer('relay_node'),
  payload_size: integer('payload_size'),
  want_ack: integer('want_ack', { mode: 'boolean' }),
  priority: integer('priority'),
  payload_preview: text('payload_preview'),
  metadata: text('metadata'),
  direction: text('direction'), // 'rx' or 'tx'
  created_at: integer('created_at'),
});

// PostgreSQL schema
export const packetLogPostgres = pgTable('packet_log', {
  id: pgSerial('id').primaryKey(),
  packet_id: pgInteger('packet_id'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  from_node: pgInteger('from_node').notNull(),
  from_node_id: pgText('from_node_id'),
  from_node_longName: pgText('from_node_longName'),
  to_node: pgInteger('to_node'),
  to_node_id: pgText('to_node_id'),
  to_node_longName: pgText('to_node_longName'),
  channel: pgInteger('channel'),
  portnum: pgInteger('portnum').notNull(),
  portnum_name: pgText('portnum_name'),
  encrypted: pgBoolean('encrypted').notNull(),
  snr: pgReal('snr'),
  rssi: pgReal('rssi'),
  hop_limit: pgInteger('hop_limit'),
  hop_start: pgInteger('hop_start'),
  relay_node: pgInteger('relay_node'),
  payload_size: pgInteger('payload_size'),
  want_ack: pgBoolean('want_ack'),
  priority: pgInteger('priority'),
  payload_preview: pgText('payload_preview'),
  metadata: pgText('metadata'),
  direction: pgText('direction'), // 'rx' or 'tx'
  created_at: pgBigint('created_at', { mode: 'number' }),
});

// MySQL schema
export const packetLogMysql = mysqlTable('packet_log', {
  id: mySerial('id').primaryKey(),
  packet_id: myInt('packet_id'),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  from_node: myInt('from_node').notNull(),
  from_node_id: myVarchar('from_node_id', { length: 32 }),
  from_node_longName: myVarchar('from_node_longName', { length: 255 }),
  to_node: myInt('to_node'),
  to_node_id: myVarchar('to_node_id', { length: 32 }),
  to_node_longName: myVarchar('to_node_longName', { length: 255 }),
  channel: myInt('channel'),
  portnum: myInt('portnum').notNull(),
  portnum_name: myVarchar('portnum_name', { length: 64 }),
  encrypted: myBoolean('encrypted').notNull(),
  snr: myDouble('snr'),
  rssi: myDouble('rssi'),
  hop_limit: myInt('hop_limit'),
  hop_start: myInt('hop_start'),
  relay_node: myInt('relay_node'),
  payload_size: myInt('payload_size'),
  want_ack: myBoolean('want_ack'),
  priority: myInt('priority'),
  payload_preview: myText('payload_preview'),
  metadata: myText('metadata'),
  direction: myVarchar('direction', { length: 8 }), // 'rx' or 'tx'
  created_at: myBigint('created_at', { mode: 'number' }),
});

// Type inference
export type PacketLogSqlite = typeof packetLogSqlite.$inferSelect;
export type NewPacketLogSqlite = typeof packetLogSqlite.$inferInsert;
export type PacketLogPostgres = typeof packetLogPostgres.$inferSelect;
export type NewPacketLogPostgres = typeof packetLogPostgres.$inferInsert;
export type PacketLogMysql = typeof packetLogMysql.$inferSelect;
export type NewPacketLogMysql = typeof packetLogMysql.$inferInsert;
