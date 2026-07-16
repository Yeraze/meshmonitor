import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, serial as mySerial, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============
//
// One row per gateway reception of an MQTT-bridged Meshtastic packet
// (ServiceEnvelope). MQTT's defining trait is N receptions per packet — one
// per gateway — so this is a reception log, not a one-row-per-packet table
// like Meshtastic `packet_log`. A grouped/dedup view is built at query time
// in MqttPacketLogRepository. Capture is opt-in
// (`mqtt_packet_log_enabled`) and bounded by the same count/age retention
// knobs as the other packet monitors.

export const mqttPacketLogSqlite = sqliteTable('mqtt_packet_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  /** ServiceEnvelope packet.id. Nullable/0 tolerated (see repo grouping edge case). */
  packetId: integer('packetId'),
  /** Unsigned 32-bit sender node number. */
  fromNode: integer('fromNode'),
  /** `!aabbccdd` form of fromNode. */
  fromNodeId: text('fromNodeId'),
  toNode: integer('toNode'),
  toNodeId: text('toNodeId'),
  /** Wire channel-hash byte (0-255), not a channel identity. */
  channel: integer('channel'),
  /** Envelope channel **name** string. */
  channelId: text('channelId'),
  /** `!aabbccdd` form of the reporting gateway's node number. */
  gatewayId: text('gatewayId'),
  /** Parsed from gatewayId; nullable when gatewayId is malformed/absent. */
  gatewayNodeNum: integer('gatewayNodeNum'),
  /** Server capture time (ms). Used for ordering and retention. */
  timestamp: integer('timestamp').notNull(),
  /** Wire rxTime converted to ms (seconds * 1000); null when wire value <= 0. */
  rxTime: integer('rxTime'),
  rxSnr: real('rxSnr'),
  rxRssi: integer('rxRssi'),
  hopLimit: integer('hopLimit'),
  hopStart: integer('hopStart'),
  /** Meshtastic PortNum; null for undecoded/encrypted copies. */
  portnum: integer('portnum'),
  /** Human-readable PortNum (e.g. TEXT_MESSAGE_APP), from meshtasticProtobufService. */
  portnumName: text('portnumName'),
  /**
   * 0/1 integer, NOT a boolean column type. This is load-bearing: the grouped
   * query does `MAX(encrypted)`, and PostgreSQL has no MAX(boolean) aggregate.
   */
  encrypted: integer('encrypted').notNull().default(0),
  /** 'server' when MeshMonitor decrypted an encrypted copy server-side, else null. */
  decryptedBy: text('decryptedBy'),
  /** 'ingested' | 'encrypted' | 'geo-filtered' | 'unsupported-portnum' | 'decode-error'. */
  ingestOutcome: text('ingestOutcome').notNull(),
  payloadSize: integer('payloadSize'),
  /** Text preview (TEXT_MESSAGE_APP only in Phase 1) or null. */
  payloadPreview: text('payloadPreview'),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const mqttPacketLogPostgres = pgTable('mqtt_packet_log', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  // Node numbers/packet ids are unsigned 32-bit; PG INTEGER is signed 32-bit.
  packetId: pgBigint('packetId', { mode: 'number' }),
  fromNode: pgBigint('fromNode', { mode: 'number' }),
  fromNodeId: pgText('fromNodeId'),
  toNode: pgBigint('toNode', { mode: 'number' }),
  toNodeId: pgText('toNodeId'),
  channel: pgInteger('channel'),
  channelId: pgText('channelId'),
  gatewayId: pgText('gatewayId'),
  gatewayNodeNum: pgBigint('gatewayNodeNum', { mode: 'number' }),
  // ms-epoch timestamps overflow 32-bit INTEGER (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  rxTime: pgBigint('rxTime', { mode: 'number' }),
  rxSnr: pgReal('rxSnr'),
  rxRssi: pgInteger('rxRssi'),
  hopLimit: pgInteger('hopLimit'),
  hopStart: pgInteger('hopStart'),
  portnum: pgInteger('portnum'),
  portnumName: pgText('portnumName'),
  // 0/1 integer, NOT boolean — see SQLite comment above (MAX(encrypted) on PG).
  encrypted: pgInteger('encrypted').notNull().default(0),
  decryptedBy: pgText('decryptedBy'),
  ingestOutcome: pgText('ingestOutcome').notNull(),
  payloadSize: pgInteger('payloadSize'),
  payloadPreview: pgText('payloadPreview'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const mqttPacketLogMysql = mysqlTable('mqtt_packet_log', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  packetId: myBigint('packetId', { mode: 'number' }),
  fromNode: myBigint('fromNode', { mode: 'number' }),
  fromNodeId: myVarchar('fromNodeId', { length: 16 }),
  toNode: myBigint('toNode', { mode: 'number' }),
  toNodeId: myVarchar('toNodeId', { length: 16 }),
  channel: myInt('channel'),
  channelId: myVarchar('channelId', { length: 64 }),
  gatewayId: myVarchar('gatewayId', { length: 32 }),
  gatewayNodeNum: myBigint('gatewayNodeNum', { mode: 'number' }),
  // ms-epoch timestamps overflow 32-bit INT (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  rxTime: myBigint('rxTime', { mode: 'number' }),
  rxSnr: myDouble('rxSnr'),
  rxRssi: myInt('rxRssi'),
  hopLimit: myInt('hopLimit'),
  hopStart: myInt('hopStart'),
  portnum: myInt('portnum'),
  portnumName: myVarchar('portnumName', { length: 48 }),
  // 0/1 integer, NOT boolean — see SQLite comment above (MAX(encrypted) on PG).
  encrypted: myInt('encrypted').notNull().default(0),
  decryptedBy: myVarchar('decryptedBy', { length: 16 }),
  ingestOutcome: myVarchar('ingestOutcome', { length: 24 }).notNull(),
  payloadSize: myInt('payloadSize'),
  payloadPreview: myVarchar('payloadPreview', { length: 256 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});
