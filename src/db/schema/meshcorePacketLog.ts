import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, serial as mySerial, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============
//
// One row per OTA packet observed via the MeshCore companion `LogRxData`
// (0x88) push. Mirrors the Meshtastic `packet_log` table but tuned to the
// MeshCore wire format: there are no node numbers or channels on the wire,
// only a payload type, a route type, and a relay-hash chain. Capture is
// opt-in (`meshcore_packet_log_enabled`) and bounded by the same
// count/age retention knobs as the Meshtastic monitor.

export const meshcorePacketLogSqlite = sqliteTable('meshcore_packet_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  /** Server capture time (ms). Used for ordering and retention. */
  timestamp: integer('timestamp').notNull(),
  /** meshcore.js Packet.payload_type (0x00–0x0F). */
  payloadType: integer('payloadType').notNull(),
  /** Human-readable payload type (TXT_MSG, ADVERT, ACK, …). */
  payloadTypeName: text('payloadTypeName'),
  /** meshcore.js Packet.route_type (0–3). */
  routeType: integer('routeType'),
  /** Human-readable route type (FLOOD, DIRECT, …). */
  routeTypeName: text('routeTypeName'),
  /** Packed wire `path_len` byte (top 2 bits = hash size index, bottom 6 = hop count). 0xFF = direct. */
  pathLenRaw: integer('pathLenRaw'),
  /** Decoded relay hop count (pathLen & 0x3F), or 0 for direct routes. */
  hopCount: integer('hopCount'),
  /** Decoded relay-hash chain as comma-separated lowercase hex ("a3,7f,02"), or null. */
  pathHops: text('pathHops'),
  /** Signal-to-noise ratio from the LogRxData metadata. */
  snr: real('snr'),
  /** Received signal strength (dBm) from the LogRxData metadata. */
  rssi: integer('rssi'),
  /** Raw OTA byte length. */
  payloadSize: integer('payloadSize'),
  /** Full raw OTA packet as a lowercase hex string. */
  rawHex: text('rawHex'),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcorePacketLogPostgres = pgTable('meshcore_packet_log', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  // ms-epoch timestamps overflow 32-bit INTEGER (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  payloadType: pgInteger('payloadType').notNull(),
  payloadTypeName: pgText('payloadTypeName'),
  routeType: pgInteger('routeType'),
  routeTypeName: pgText('routeTypeName'),
  pathLenRaw: pgInteger('pathLenRaw'),
  hopCount: pgInteger('hopCount'),
  pathHops: pgText('pathHops'),
  snr: pgReal('snr'),
  rssi: pgInteger('rssi'),
  payloadSize: pgInteger('payloadSize'),
  rawHex: pgText('rawHex'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcorePacketLogMysql = mysqlTable('meshcore_packet_log', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  // ms-epoch timestamps overflow 32-bit INT (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  payloadType: myInt('payloadType').notNull(),
  payloadTypeName: myVarchar('payloadTypeName', { length: 32 }),
  routeType: myInt('routeType'),
  routeTypeName: myVarchar('routeTypeName', { length: 32 }),
  pathLenRaw: myInt('pathLenRaw'),
  hopCount: myInt('hopCount'),
  pathHops: myVarchar('pathHops', { length: 512 }),
  snr: myDouble('snr'),
  rssi: myInt('rssi'),
  payloadSize: myInt('payloadSize'),
  rawHex: myText('rawHex'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});
