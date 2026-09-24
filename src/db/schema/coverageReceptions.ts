/**
 * Drizzle schema for the `coverage_receptions` table (Coverage Report epic
 * #5277, Phase 1 WP1).
 *
 * One row per (packet, path, receiver): every distinct path a position fix
 * was heard on by a receiver is its own row, so a directly-heard copy and a
 * relayed copy of the same packet both survive. `protocol` /
 * `receiverKind` are forward-looking discriminators — P1/WP2 writes only
 * `protocol: 'meshtastic'`, `receiverKind: 'local'` (this source's own
 * radio), but the shape already accommodates P2 (`receiverKind:
 * 'mqtt_gateway'`, one row per reporting gateway) and P3
 * (`protocol: 'meshcore'`) without a schema change.
 *
 * PER-SOURCE (`sourceId`, scoped) — every row belongs to the source whose
 * receiver heard the packet. Ephemeral/regenerable data (bounded by the
 * unique key plus retention): NOT in `BACKUP_TABLES` (Decision D9).
 *
 * `receiverLatitude` / `receiverLongitude` are a SNAPSHOT of the receiver's
 * position at receive time, not a live reference — a receiver that moves
 * (or repositions) later must not rewrite history for older rows.
 *
 * `packetKey` is the cross-protocol replay/dedupe key: Meshtastic
 * `String(packetId)` (P1/P2), a MeshCore packet hash (P3). `pathKey` is the
 * per-path identity within one packetKey (`src/utils/coverage.ts`
 * `meshtasticPathKey`) — it is what lets a direct copy and a relayed copy of
 * the same packet, heard by the same receiver, both survive as distinct
 * rows. Never empty.
 *
 * Modeled on `meshtasticHeardRepeaters.ts` (closest analog: a per-source side
 * table written from the Meshtastic RX path, whose writes must never break
 * RX). Unlike that table, this one never merges/updates on a repeat key —
 * `recordReception` is first-write-wins via `insertIgnore` (a later copy on
 * the same path is a replay or retransmission, not new information).
 *
 * Indexes (declared in migration 172, not here — this file matches the
 * project convention of DDL-only indexes, see `meshtasticHeardRepeaters.ts`):
 *  - UNIQUE `cov_rx_path_uniq (sourceId, receiverId, senderId, packetKey, pathKey)`
 *  - `cov_rx_received_idx (receivedAt)` — global purge.
 *  - `cov_rx_source_received_idx (sourceId, receivedAt)` — window query + getReceivers.
 *  - `cov_rx_sender_received_idx (senderId, receivedAt)` — sender filter.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDouble } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const coverageReceptionsSqlite = sqliteTable('coverage_receptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Owning source (the device/gateway that heard the reception).
  sourceId: text('sourceId').notNull(),
  // 'meshtastic' (P1/P2), 'meshcore' (P3).
  protocol: text('protocol').notNull(),
  // 'local' (P1/P3, this source's own radio), 'mqtt_gateway' (P2).
  receiverKind: text('receiverKind').notNull(),
  // Canonical receiver id: Meshtastic `!xxxxxxxx`, MeshCore pubkey hex.
  receiverId: text('receiverId').notNull(),
  // Meshtastic only; null for other protocols.
  receiverNodeNum: integer('receiverNodeNum'),
  // Receiver position SNAPSHOT at receive time (not a live reference).
  receiverLatitude: real('receiverLatitude'),
  receiverLongitude: real('receiverLongitude'),
  // Canonical sender id: `!xxxxxxxx` or MeshCore pubkey hex.
  senderId: text('senderId').notNull(),
  // Meshtastic only (also the privacy-gate key); null for other protocols.
  senderNodeNum: integer('senderNodeNum'),
  // Cross-protocol replay/dedupe key: Meshtastic String(packetId); MeshCore packet hash (P3).
  packetKey: text('packetKey').notNull(),
  // Meshtastic packet id (uint32); null for other protocols.
  packetId: integer('packetId'),
  // Per-path identity within one packetKey (meshtasticPathKey). Never empty.
  pathKey: text('pathKey').notNull(),
  // The fix.
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  altitude: real('altitude'),
  precisionBits: integer('precisionBits'),
  // dB, fractional. -128 sentinel is stored as NULL.
  snr: real('snr'),
  // dBm. Absent = NULL; 0 is a real, explicit-presence value (fw 2.8+).
  rssi: integer('rssi'),
  hopStart: integer('hopStart'),
  hopLimit: integer('hopLimit'),
  // Derived (computeMeshtasticHopsAway). NULL = unknown.
  hopsAway: integer('hopsAway'),
  // Meshtastic: last byte of the relaying node's nodeNum.
  relayNode: integer('relayNode'),
  transportMechanism: integer('transportMechanism'),
  // Resolved channel slot (same convention as telemetry).
  channel: integer('channel'),
  // Device receive clock, unix SECONDS. Nullable/implausible tolerated.
  rxTime: integer('rxTime'),
  // Server receive time, unix MS. Drives the window query, cursor and purge.
  receivedAt: integer('receivedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const coverageReceptionsPostgres = pgTable('coverage_receptions', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  protocol: pgText('protocol').notNull(),
  receiverKind: pgText('receiverKind').notNull(),
  receiverId: pgText('receiverId').notNull(),
  // Meshtastic node numbers are unsigned 32-bit; PG INTEGER is signed 32-bit.
  receiverNodeNum: pgBigint('receiverNodeNum', { mode: 'number' }),
  receiverLatitude: pgDouble('receiverLatitude'),
  receiverLongitude: pgDouble('receiverLongitude'),
  senderId: pgText('senderId').notNull(),
  senderNodeNum: pgBigint('senderNodeNum', { mode: 'number' }),
  packetKey: pgText('packetKey').notNull(),
  packetId: pgBigint('packetId', { mode: 'number' }),
  pathKey: pgText('pathKey').notNull(),
  latitude: pgDouble('latitude').notNull(),
  longitude: pgDouble('longitude').notNull(),
  altitude: pgReal('altitude'),
  precisionBits: pgInteger('precisionBits'),
  snr: pgReal('snr'),
  rssi: pgInteger('rssi'),
  hopStart: pgInteger('hopStart'),
  hopLimit: pgInteger('hopLimit'),
  hopsAway: pgInteger('hopsAway'),
  relayNode: pgInteger('relayNode'),
  transportMechanism: pgInteger('transportMechanism'),
  channel: pgInteger('channel'),
  rxTime: pgBigint('rxTime', { mode: 'number' }),
  receivedAt: pgBigint('receivedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const coverageReceptionsMysql = mysqlTable('coverage_receptions', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  protocol: myVarchar('protocol', { length: 16 }).notNull(),
  receiverKind: myVarchar('receiverKind', { length: 16 }).notNull(),
  receiverId: myVarchar('receiverId', { length: 80 }).notNull(),
  receiverNodeNum: myBigint('receiverNodeNum', { mode: 'number' }),
  receiverLatitude: myDouble('receiverLatitude'),
  receiverLongitude: myDouble('receiverLongitude'),
  senderId: myVarchar('senderId', { length: 80 }).notNull(),
  senderNodeNum: myBigint('senderNodeNum', { mode: 'number' }),
  packetKey: myVarchar('packetKey', { length: 80 }).notNull(),
  packetId: myBigint('packetId', { mode: 'number' }),
  pathKey: myVarchar('pathKey', { length: 32 }).notNull(),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  altitude: myDouble('altitude'),
  precisionBits: myInt('precisionBits'),
  snr: myDouble('snr'),
  rssi: myInt('rssi'),
  hopStart: myInt('hopStart'),
  hopLimit: myInt('hopLimit'),
  hopsAway: myInt('hopsAway'),
  relayNode: myInt('relayNode'),
  transportMechanism: myInt('transportMechanism'),
  channel: myInt('channel'),
  rxTime: myBigint('rxTime', { mode: 'number' }),
  receivedAt: myBigint('receivedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type CoverageReceptionSqlite = typeof coverageReceptionsSqlite.$inferSelect;
export type NewCoverageReceptionSqlite = typeof coverageReceptionsSqlite.$inferInsert;
export type CoverageReceptionPostgres = typeof coverageReceptionsPostgres.$inferSelect;
export type NewCoverageReceptionPostgres = typeof coverageReceptionsPostgres.$inferInsert;
export type CoverageReceptionMysql = typeof coverageReceptionsMysql.$inferSelect;
export type NewCoverageReceptionMysql = typeof coverageReceptionsMysql.$inferInsert;
