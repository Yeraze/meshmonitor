/**
 * Drizzle schema definition for the packet_log table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';

// SQLite schema
// Note: from_node_longName and to_node_longName are computed via JOIN on read, not stored
export const packetLogSqlite = sqliteTable('packet_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  packet_id: integer('packet_id'),
  timestamp: integer('timestamp').notNull(),
  from_node: integer('from_node').notNull(),
  from_node_id: text('from_node_id'),
  to_node: integer('to_node'),
  to_node_id: text('to_node_id'),
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
  decrypted_by: text('decrypted_by'), // 'node' | 'server' | null
  decrypted_channel_id: integer('decrypted_channel_id'), // FK to channel_database.id
});

// PostgreSQL schema
// Note: from_node_longName and to_node_longName are computed via JOIN on read, not stored
// Note: packet_id, from_node, to_node, relay_node use BIGINT because Meshtastic node IDs
// are unsigned 32-bit integers (0 to 4,294,967,295) which exceed PostgreSQL's signed INTEGER max
export const packetLogPostgres = pgTable('packet_log', {
  id: pgSerial('id').primaryKey(),
  packet_id: pgBigint('packet_id', { mode: 'number' }),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  from_node: pgBigint('from_node', { mode: 'number' }).notNull(),
  from_node_id: pgText('from_node_id'),
  to_node: pgBigint('to_node', { mode: 'number' }),
  to_node_id: pgText('to_node_id'),
  channel: pgInteger('channel'),
  portnum: pgInteger('portnum').notNull(),
  portnum_name: pgText('portnum_name'),
  encrypted: pgBoolean('encrypted').notNull(),
  snr: pgReal('snr'),
  rssi: pgReal('rssi'),
  hop_limit: pgInteger('hop_limit'),
  hop_start: pgInteger('hop_start'),
  relay_node: pgBigint('relay_node', { mode: 'number' }),
  payload_size: pgInteger('payload_size'),
  want_ack: pgBoolean('want_ack'),
  priority: pgInteger('priority'),
  payload_preview: pgText('payload_preview'),
  metadata: pgText('metadata'),
  direction: pgText('direction'), // 'rx' or 'tx'
  created_at: pgBigint('created_at', { mode: 'number' }),
  decrypted_by: pgText('decrypted_by'), // 'node' | 'server' | null
  decrypted_channel_id: pgInteger('decrypted_channel_id'), // FK to channel_database.id
});

// MySQL schema
// Note: from_node_longName and to_node_longName are computed via JOIN on read, not stored
// Note: packet_id, from_node, to_node, relay_node use BIGINT because Meshtastic node IDs
// are unsigned 32-bit integers (0 to 4,294,967,295) which exceed MySQL's signed INT max
export const packetLogMysql = mysqlTable('packet_log', {
  id: mySerial('id').primaryKey(),
  packet_id: myBigint('packet_id', { mode: 'number' }),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  from_node: myBigint('from_node', { mode: 'number' }).notNull(),
  from_node_id: myVarchar('from_node_id', { length: 32 }),
  to_node: myBigint('to_node', { mode: 'number' }),
  to_node_id: myVarchar('to_node_id', { length: 32 }),
  channel: myInt('channel'),
  portnum: myInt('portnum').notNull(),
  portnum_name: myVarchar('portnum_name', { length: 64 }),
  encrypted: myBoolean('encrypted').notNull(),
  snr: myDouble('snr'),
  rssi: myDouble('rssi'),
  hop_limit: myInt('hop_limit'),
  hop_start: myInt('hop_start'),
  relay_node: myBigint('relay_node', { mode: 'number' }),
  payload_size: myInt('payload_size'),
  want_ack: myBoolean('want_ack'),
  priority: myInt('priority'),
  payload_preview: myText('payload_preview'),
  metadata: myText('metadata'),
  direction: myVarchar('direction', { length: 8 }), // 'rx' or 'tx'
  created_at: myBigint('created_at', { mode: 'number' }),
  decrypted_by: myVarchar('decrypted_by', { length: 16 }), // 'node' | 'server' | null
  decrypted_channel_id: myInt('decrypted_channel_id'), // FK to channel_database.id
});

// Type inference
export type PacketLogSqlite = typeof packetLogSqlite.$inferSelect;
export type NewPacketLogSqlite = typeof packetLogSqlite.$inferInsert;
export type PacketLogPostgres = typeof packetLogPostgres.$inferSelect;
export type NewPacketLogPostgres = typeof packetLogPostgres.$inferInsert;
export type PacketLogMysql = typeof packetLogMysql.$inferSelect;
export type NewPacketLogMysql = typeof packetLogMysql.$inferInsert;
