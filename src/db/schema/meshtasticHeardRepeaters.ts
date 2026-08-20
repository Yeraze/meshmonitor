/**
 * Drizzle schema for the `meshtastic_heard_repeaters` side table (Delivery
 * Diagnostics epic #4816, Phase 4 WP1 — Meshtastic Heard-By).
 *
 * Meshtastic channel (broadcast) messages carry no protocol-level ACK, but a
 * repeater that re-floods our own outgoing packet is delivered back to the
 * host as an ordinary inbound RF packet — the same case the local-node spoof
 * guard (#2584) exists to NOT misclassify. We identify a re-flood as: the
 * packet claims OUR node as origin, its packet id is one we recently sent
 * (`sentPacketIds`), it arrived over RF (not a genuine local TX, not an MQTT
 * echo), and it carries a `relay_node` byte. We record that byte + the SNR at
 * which we heard it.
 *
 * `relay_node` is only the LAST BYTE of the relaying node's nodeNum
 * (Meshtastic protobuf), so identity is inherently ambiguous (up to 256 nodes
 * share a value) — candidate resolution to node name(s) happens at query
 * time (WP3), never at write time. This table stores only the raw byte.
 *
 * One row per (message, relay byte). PER-SOURCE (`sourceId`, scoped) — a row
 * belongs to the source whose device heard the re-flood. A side table (rather
 * than a JSON column on `messages`) keeps the variable-length list
 * normalized and avoids read-modify-write races as multiple re-floods stream
 * in. Modeled directly on `meshcoreHeardRepeaters.ts` — the MeshCore analog —
 * except `snr` is `real`/`double` here (Meshtastic `rxSnr` is fractional,
 * e.g. -7.25; MeshCore's integer SNR column does NOT apply).
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshtasticHeardRepeatersSqlite = sqliteTable('meshtastic_heard_repeaters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Owning source (the device that heard the re-flood).
  sourceId: text('sourceId').notNull(),
  // FK-ish to messages.id (`${sourceId}_${fromNum}_${packetId}`) — the
  // outgoing channel message that was relayed.
  messageId: text('messageId').notNull(),
  // Last byte of the relaying node's nodeNum (1-255; 0/unknown never stored).
  relayByte: integer('relayByte').notNull(),
  // Best (max) SNR observed for this relay byte across re-floods (nullable, fractional).
  snr: real('snr'),
  // When the re-flood was heard (Unix ms).
  heardAt: integer('heardAt').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshtasticHeardRepeatersPostgres = pgTable('meshtastic_heard_repeaters', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  messageId: pgText('messageId').notNull(),
  relayByte: pgInteger('relayByte').notNull(),
  snr: pgReal('snr'),
  heardAt: pgBigint('heardAt', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshtasticHeardRepeatersMysql = mysqlTable('meshtastic_heard_repeaters', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  messageId: myVarchar('messageId', { length: 96 }).notNull(),
  relayByte: myInt('relayByte').notNull(),
  snr: myDouble('snr'),
  heardAt: myBigint('heardAt', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshtasticHeardRepeaterSqlite = typeof meshtasticHeardRepeatersSqlite.$inferSelect;
export type NewMeshtasticHeardRepeaterSqlite = typeof meshtasticHeardRepeatersSqlite.$inferInsert;
export type MeshtasticHeardRepeaterPostgres = typeof meshtasticHeardRepeatersPostgres.$inferSelect;
export type NewMeshtasticHeardRepeaterPostgres = typeof meshtasticHeardRepeatersPostgres.$inferInsert;
export type MeshtasticHeardRepeaterMysql = typeof meshtasticHeardRepeatersMysql.$inferSelect;
export type NewMeshtasticHeardRepeaterMysql = typeof meshtasticHeardRepeatersMysql.$inferInsert;
