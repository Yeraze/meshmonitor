import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, serial as mySerial, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============
//
// Durable history of *confirmed* `ok_to_mqtt` violations (issue #4114): a
// gateway relayed another node's packet to MQTT while that packet's
// `Data.bitfield` bit 0 was explicitly clear. This is deliberately a
// separate table from `mqtt_packet_log`, not a flag/extra columns there,
// because it needs retention immunity relative to the packet log's 24h /
// 5,000-row trim (`mqttPacketLogService.ts`) — Phase 3 needs a weeks-long
// lookback for its violation report, and the packet log's aggressive
// retention would silently discard that history. See
// docs/internal/dev-notes/MQTT_OK_TO_MQTT_PHASE1_SPEC.md §1.9/§2(d).
//
// Rows are written ONLY for confirmed violations (`state === 'no' &&
// relayed`) — "unknown" (undecryptable) receptions are never persisted here;
// on a busy encrypted source that would be the same volume as the packet log
// and defeat the retention-immunity argument. "Suspected" (unknown-bitfield)
// entries are instead served from `mqtt_packet_log` at query time, bounded by
// its own retention window (spec §2(e)).
//
// Own retention sweep, own settings, dedupe via a unique index on the
// natural reception key. Capture is gated by
// `mqtt_oktomqtt_violation_log_enabled` (default ON, unlike the opt-in
// packet log) — see `src/server/constants/settings.ts`.

export const mqttOkToMqttViolationsSqlite = sqliteTable('mqtt_ok_to_mqtt_violations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  /** ServiceEnvelope packet.id. Nullable/0 tolerated (cannot dedupe — see file header). */
  packetId: integer('packetId'),
  /** Unsigned 32-bit originator node number. */
  fromNode: integer('fromNode'),
  /** `!aabbccdd` form of fromNode. */
  fromNodeId: text('fromNodeId'),
  /** `!aabbccdd` form of the relaying gateway's node number. */
  gatewayId: text('gatewayId'),
  /** Parsed from gatewayId; nullable when gatewayId is malformed/absent. */
  gatewayNodeNum: integer('gatewayNodeNum'),
  /** Envelope channel **name** string. */
  channelId: text('channelId'),
  /** Meshtastic PortNum. */
  portnum: integer('portnum'),
  /** Human-readable PortNum (e.g. TEXT_MESSAGE_APP). */
  portnumName: text('portnumName'),
  /** Raw `Data.bitfield` (protobuf field 9). Always non-null and even (bit 0 clear) on a confirmed row. */
  bitfield: integer('bitfield'),
  /** Raw MQTT topic this reception arrived on. Diagnostic. */
  topic: text('topic'),
  /** Wire rxTime converted to ms; nullable. */
  rxTime: integer('rxTime'),
  /** Server capture time (ms). Ordering + retention cutoff. */
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const mqttOkToMqttViolationsPostgres = pgTable('mqtt_ok_to_mqtt_violations', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  // Node numbers/packet ids are unsigned 32-bit; PG INTEGER is signed 32-bit.
  packetId: pgBigint('packetId', { mode: 'number' }),
  fromNode: pgBigint('fromNode', { mode: 'number' }),
  fromNodeId: pgText('fromNodeId'),
  gatewayId: pgText('gatewayId'),
  gatewayNodeNum: pgBigint('gatewayNodeNum', { mode: 'number' }),
  channelId: pgText('channelId'),
  portnum: pgInteger('portnum'),
  portnumName: pgText('portnumName'),
  bitfield: pgInteger('bitfield'),
  topic: pgText('topic'),
  rxTime: pgBigint('rxTime', { mode: 'number' }),
  // ms-epoch timestamps overflow 32-bit INTEGER (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const mqttOkToMqttViolationsMysql = mysqlTable('mqtt_ok_to_mqtt_violations', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  packetId: myBigint('packetId', { mode: 'number' }),
  fromNode: myBigint('fromNode', { mode: 'number' }),
  fromNodeId: myVarchar('fromNodeId', { length: 16 }),
  gatewayId: myVarchar('gatewayId', { length: 32 }),
  gatewayNodeNum: myBigint('gatewayNodeNum', { mode: 'number' }),
  channelId: myVarchar('channelId', { length: 64 }),
  portnum: myInt('portnum'),
  portnumName: myVarchar('portnumName', { length: 48 }),
  bitfield: myInt('bitfield'),
  topic: myVarchar('topic', { length: 512 }),
  rxTime: myBigint('rxTime', { mode: 'number' }),
  // ms-epoch timestamps overflow 32-bit INT (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});
