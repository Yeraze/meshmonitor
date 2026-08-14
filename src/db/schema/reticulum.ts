/**
 * Drizzle schema for the Reticulum source type (epic #3960, Phase 1a WP1 +
 * Phase 2 WP2).
 *
 * Three tables, all PER-SOURCE (every row carries a `sourceId`):
 *
 *  - `reticulum_destinations` — one row per announced destination hash
 *    observed by the bridge. Phase 1a INCLUDES the per-packet signal columns
 *    (`rssi`/`snr`/`quality`, available in attach mode) but EXCLUDES
 *    position/telemetry columns (Phase 3).
 *  - `reticulum_interfaces` — one row per RNS interface snapshot (the
 *    `rnstatus` view). Phase 1a EXCLUDES LoRa-parameter columns
 *    (frequency/bandwidth/SF/CR/txPower/airtime — Phase 3 own-mode radio
 *    config).
 *  - `reticulum_messages` — one row per LXMF message (inbound or outbound).
 *    `id` is the composite key `${sourceId}_${lxmHashHex}` (see the
 *    `messages.id` row-id convention). Phase 2 scope: UTF-8 text
 *    `content`/`title` + attachment metadata in `fields`; raw blob transfer
 *    is deferred.
 *
 * See `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.1/§3.2 and
 * `docs/internal/dev-notes/RETICULUM_PHASE2_BUILD_SPEC.md` §4 for the exact
 * column lists and rationale. Matches migrations 141/142/143 exactly.
 */
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  doublePrecision as pgDoublePrecision,
  boolean as pgBoolean,
  bigint as pgBigint,
  uniqueIndex as pgUniqueIndex,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  text as myText,
  int as myInt,
  double as myDouble,
  boolean as myBoolean,
  bigint as myBigint,
  uniqueIndex as myUniqueIndex,
  index as myIndex,
} from 'drizzle-orm/mysql-core';

// ============================================================================
// reticulum_destinations
// ============================================================================

// ============ SQLite Schema ============

export const reticulumDestinationsSqlite = sqliteTable('reticulum_destinations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  destinationHash: text('destinationHash').notNull(),
  identityHash: text('identityHash'),
  appName: text('appName'),
  aspects: text('aspects'),
  displayName: text('displayName'),
  appDataB64: text('appDataB64'),
  hops: integer('hops'),
  nextHopInterface: text('nextHopInterface'),
  /** Per-packet RSSI on last announce (attach mode only). */
  rssi: integer('rssi'),
  /** Per-packet SNR on last announce (attach mode only). */
  snr: real('snr'),
  /** Normalised link quality `q` (attach mode only). */
  quality: integer('quality'),
  announceCount: integer('announceCount').notNull().default(0),
  firstSeen: integer('firstSeen').notNull(),
  lastSeen: integer('lastSeen').notNull(),
  lastAnnounceAt: integer('lastAnnounceAt'),
  isFavorite: integer('isFavorite', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  /** Sideband SID_LOCATION sample (migration 144). Peer-shared, latest-only overwrite. */
  latitude: real('latitude'),
  longitude: real('longitude'),
  altitude: real('altitude'),
  speed: real('speed'),
  bearing: real('bearing'),
  accuracy: real('accuracy'),
  /** ms epoch of the latest position sample; null when never observed. */
  positionUpdatedAt: integer('positionUpdatedAt'),
}, (t) => ({
  sourceHashIdx: uniqueIndex('reticulum_destinations_source_hash_idx').on(t.sourceId, t.destinationHash),
  sourceLastSeenIdx: index('reticulum_destinations_source_lastseen_idx').on(t.sourceId, t.lastSeen),
}));

// ============ PostgreSQL Schema ============

export const reticulumDestinationsPostgres = pgTable('reticulum_destinations', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  destinationHash: pgText('destinationHash').notNull(),
  identityHash: pgText('identityHash'),
  appName: pgText('appName'),
  aspects: pgText('aspects'),
  displayName: pgText('displayName'),
  appDataB64: pgText('appDataB64'),
  hops: pgInteger('hops'),
  nextHopInterface: pgText('nextHopInterface'),
  rssi: pgInteger('rssi'),
  snr: pgDoublePrecision('snr'),
  quality: pgInteger('quality'),
  announceCount: pgInteger('announceCount').notNull().default(0),
  // ms-epoch timestamps overflow 32-bit INTEGER; JS Date.now() is ~1.8e12.
  firstSeen: pgBigint('firstSeen', { mode: 'number' }).notNull(),
  lastSeen: pgBigint('lastSeen', { mode: 'number' }).notNull(),
  lastAnnounceAt: pgBigint('lastAnnounceAt', { mode: 'number' }),
  isFavorite: pgBoolean('isFavorite').notNull().default(false),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  latitude: pgDoublePrecision('latitude'),
  longitude: pgDoublePrecision('longitude'),
  altitude: pgDoublePrecision('altitude'),
  speed: pgDoublePrecision('speed'),
  bearing: pgDoublePrecision('bearing'),
  accuracy: pgDoublePrecision('accuracy'),
  positionUpdatedAt: pgBigint('positionUpdatedAt', { mode: 'number' }),
}, (t) => ({
  sourceHashIdx: pgUniqueIndex('reticulum_destinations_source_hash_idx').on(t.sourceId, t.destinationHash),
  sourceLastSeenIdx: pgIndex('reticulum_destinations_source_lastseen_idx').on(t.sourceId, t.lastSeen),
}));

// ============ MySQL Schema ============

export const reticulumDestinationsMysql = mysqlTable('reticulum_destinations', {
  id: myInt('id').primaryKey().autoincrement(),
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  destinationHash: myVarchar('destinationHash', { length: 64 }).notNull(),
  identityHash: myVarchar('identityHash', { length: 64 }),
  appName: myVarchar('appName', { length: 255 }),
  aspects: myVarchar('aspects', { length: 255 }),
  displayName: myVarchar('displayName', { length: 255 }),
  appDataB64: myText('appDataB64'),
  hops: myInt('hops'),
  nextHopInterface: myVarchar('nextHopInterface', { length: 255 }),
  rssi: myInt('rssi'),
  snr: myDouble('snr'),
  quality: myInt('quality'),
  announceCount: myInt('announceCount').notNull().default(0),
  firstSeen: myBigint('firstSeen', { mode: 'number' }).notNull(),
  lastSeen: myBigint('lastSeen', { mode: 'number' }).notNull(),
  lastAnnounceAt: myBigint('lastAnnounceAt', { mode: 'number' }),
  isFavorite: myBoolean('isFavorite').notNull().default(false),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  latitude: myDouble('latitude'),
  longitude: myDouble('longitude'),
  altitude: myDouble('altitude'),
  speed: myDouble('speed'),
  bearing: myDouble('bearing'),
  accuracy: myDouble('accuracy'),
  positionUpdatedAt: myBigint('positionUpdatedAt', { mode: 'number' }),
}, (t) => ({
  sourceHashIdx: myUniqueIndex('reticulum_destinations_source_hash_idx').on(t.sourceId, t.destinationHash),
}));

// ============================================================================
// reticulum_interfaces
// ============================================================================

// ============ SQLite Schema ============

export const reticulumInterfacesSqlite = sqliteTable('reticulum_interfaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  interfaceName: text('interfaceName').notNull(),
  interfaceType: text('interfaceType'),
  interfaceHash: text('interfaceHash'),
  mode: text('mode'),
  status: text('status').notNull(),
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  bitrate: integer('bitrate'),
  txBytes: integer('txBytes').notNull().default(0),
  rxBytes: integer('rxBytes').notNull().default(0),
  lastSeenAt: integer('lastSeenAt').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  /** Own-mode RNode radio config (migration 145). Null for attach/tcp_peer sources. */
  frequency: real('frequency'),
  bandwidth: real('bandwidth'),
  spreadingFactor: integer('spreadingFactor'),
  codingRate: integer('codingRate'),
  txPower: integer('txPower'),
  stAlock: real('stAlock'),
  ltAlock: real('ltAlock'),
  radioState: integer('radioState', { mode: 'boolean' }),
  /** Loose JSON text — read-only RNode board/firmware info (R2). */
  deviceInfoJson: text('deviceInfoJson'),
}, (t) => ({
  sourceNameIdx: uniqueIndex('reticulum_interfaces_source_name_idx').on(t.sourceId, t.interfaceName),
}));

// ============ PostgreSQL Schema ============

export const reticulumInterfacesPostgres = pgTable('reticulum_interfaces', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  interfaceName: pgText('interfaceName').notNull(),
  interfaceType: pgText('interfaceType'),
  interfaceHash: pgText('interfaceHash'),
  mode: pgText('mode'),
  status: pgText('status').notNull(),
  online: pgBoolean('online').notNull().default(false),
  bitrate: pgInteger('bitrate'),
  // BIGINT — cumulative byte counters can exceed 32-bit INTEGER.
  txBytes: pgBigint('txBytes', { mode: 'number' }).notNull().default(0),
  rxBytes: pgBigint('rxBytes', { mode: 'number' }).notNull().default(0),
  lastSeenAt: pgBigint('lastSeenAt', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  frequency: pgDoublePrecision('frequency'),
  bandwidth: pgDoublePrecision('bandwidth'),
  spreadingFactor: pgInteger('spreadingFactor'),
  codingRate: pgInteger('codingRate'),
  txPower: pgInteger('txPower'),
  stAlock: pgDoublePrecision('stAlock'),
  ltAlock: pgDoublePrecision('ltAlock'),
  radioState: pgBoolean('radioState'),
  deviceInfoJson: pgText('deviceInfoJson'),
}, (t) => ({
  sourceNameIdx: pgUniqueIndex('reticulum_interfaces_source_name_idx').on(t.sourceId, t.interfaceName),
}));

// ============ MySQL Schema ============

export const reticulumInterfacesMysql = mysqlTable('reticulum_interfaces', {
  id: myInt('id').primaryKey().autoincrement(),
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  interfaceName: myVarchar('interfaceName', { length: 255 }).notNull(),
  interfaceType: myVarchar('interfaceType', { length: 128 }),
  interfaceHash: myVarchar('interfaceHash', { length: 64 }),
  mode: myVarchar('mode', { length: 64 }),
  status: myVarchar('status', { length: 16 }).notNull(),
  online: myBoolean('online').notNull().default(false),
  bitrate: myInt('bitrate'),
  txBytes: myBigint('txBytes', { mode: 'number' }).notNull().default(0),
  rxBytes: myBigint('rxBytes', { mode: 'number' }).notNull().default(0),
  lastSeenAt: myBigint('lastSeenAt', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  frequency: myDouble('frequency'),
  bandwidth: myDouble('bandwidth'),
  spreadingFactor: myInt('spreadingFactor'),
  codingRate: myInt('codingRate'),
  txPower: myInt('txPower'),
  stAlock: myDouble('stAlock'),
  ltAlock: myDouble('ltAlock'),
  radioState: myBoolean('radioState'),
  deviceInfoJson: myText('deviceInfoJson'),
}, (t) => ({
  sourceNameIdx: myUniqueIndex('reticulum_interfaces_source_name_idx').on(t.sourceId, t.interfaceName),
}));

// ============================================================================
// reticulum_messages
// ============================================================================

// ============ SQLite Schema ============

export const reticulumMessagesSqlite = sqliteTable('reticulum_messages', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  fromHash: text('fromHash').notNull(),
  toHash: text('toHash').notNull(),
  title: text('title'),
  content: text('content'),
  timestamp: integer('timestamp').notNull(),
  receivedAt: integer('receivedAt'),
  createdAt: integer('createdAt').notNull(),
  /** draft | outbound | sending | sent | delivered | failed */
  state: text('state').notNull(),
  /** opportunistic | direct | propagated */
  method: text('method'),
  signatureValidated: integer('signatureValidated', { mode: 'boolean' }).notNull().default(false),
  ratcheted: integer('ratcheted', { mode: 'boolean' }).notNull().default(false),
  /** JSON text — replies/reactions/thread markers + attachment metadata (name/type/size/ref). */
  fields: text('fields'),
  replyToHash: text('replyToHash'),
  threadHash: text('threadHash'),
  /** Per-packet RSSI on receipt (attach mode only). */
  rssi: integer('rssi'),
  /** Per-packet SNR on receipt (attach mode only). */
  snr: real('snr'),
  /** Normalised link quality `q` (attach mode only). */
  quality: integer('quality'),
}, (t) => ({
  sourceToFromTsIdx: index('reticulum_messages_source_to_from_ts_idx').on(t.sourceId, t.toHash, t.fromHash, t.timestamp),
  sourceThreadIdx: index('reticulum_messages_source_thread_idx').on(t.sourceId, t.threadHash),
}));

// ============ PostgreSQL Schema ============

export const reticulumMessagesPostgres = pgTable('reticulum_messages', {
  id: pgText('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  fromHash: pgText('fromHash').notNull(),
  toHash: pgText('toHash').notNull(),
  title: pgText('title'),
  content: pgText('content'),
  // ms-epoch timestamps overflow 32-bit INTEGER; JS Date.now() is ~1.8e12.
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  receivedAt: pgBigint('receivedAt', { mode: 'number' }),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  state: pgText('state').notNull(),
  method: pgText('method'),
  signatureValidated: pgBoolean('signatureValidated').notNull().default(false),
  ratcheted: pgBoolean('ratcheted').notNull().default(false),
  fields: pgText('fields'),
  replyToHash: pgText('replyToHash'),
  threadHash: pgText('threadHash'),
  rssi: pgInteger('rssi'),
  snr: pgDoublePrecision('snr'),
  quality: pgInteger('quality'),
}, (t) => ({
  sourceToFromTsIdx: pgIndex('reticulum_messages_source_to_from_ts_idx').on(t.sourceId, t.toHash, t.fromHash, t.timestamp),
  sourceThreadIdx: pgIndex('reticulum_messages_source_thread_idx').on(t.sourceId, t.threadHash),
}));

// ============ MySQL Schema ============

export const reticulumMessagesMysql = mysqlTable('reticulum_messages', {
  id: myVarchar('id', { length: 191 }).primaryKey(),
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  fromHash: myVarchar('fromHash', { length: 64 }).notNull(),
  toHash: myVarchar('toHash', { length: 64 }).notNull(),
  title: myText('title'),
  content: myText('content'),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  receivedAt: myBigint('receivedAt', { mode: 'number' }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  state: myVarchar('state', { length: 16 }).notNull(),
  method: myVarchar('method', { length: 16 }),
  signatureValidated: myBoolean('signatureValidated').notNull().default(false),
  ratcheted: myBoolean('ratcheted').notNull().default(false),
  fields: myText('fields'),
  replyToHash: myText('replyToHash'),
  threadHash: myVarchar('threadHash', { length: 64 }),
  rssi: myInt('rssi'),
  snr: myDouble('snr'),
  quality: myInt('quality'),
}, (t) => ({
  sourceToFromTsIdx: myIndex('reticulum_messages_source_to_from_ts_idx').on(t.sourceId, t.toHash, t.fromHash, t.timestamp),
  sourceThreadIdx: myIndex('reticulum_messages_source_thread_idx').on(t.sourceId, t.threadHash),
}));

// ============ TYPE INFERENCE ============

export type ReticulumDestinationSqlite = typeof reticulumDestinationsSqlite.$inferSelect;
export type NewReticulumDestinationSqlite = typeof reticulumDestinationsSqlite.$inferInsert;
export type ReticulumDestinationPostgres = typeof reticulumDestinationsPostgres.$inferSelect;
export type NewReticulumDestinationPostgres = typeof reticulumDestinationsPostgres.$inferInsert;
export type ReticulumDestinationMysql = typeof reticulumDestinationsMysql.$inferSelect;
export type NewReticulumDestinationMysql = typeof reticulumDestinationsMysql.$inferInsert;

export type ReticulumInterfaceSqlite = typeof reticulumInterfacesSqlite.$inferSelect;
export type NewReticulumInterfaceSqlite = typeof reticulumInterfacesSqlite.$inferInsert;
export type ReticulumInterfacePostgres = typeof reticulumInterfacesPostgres.$inferSelect;
export type NewReticulumInterfacePostgres = typeof reticulumInterfacesPostgres.$inferInsert;
export type ReticulumInterfaceMysql = typeof reticulumInterfacesMysql.$inferSelect;
export type NewReticulumInterfaceMysql = typeof reticulumInterfacesMysql.$inferInsert;

export type ReticulumMessageSqlite = typeof reticulumMessagesSqlite.$inferSelect;
export type NewReticulumMessageSqlite = typeof reticulumMessagesSqlite.$inferInsert;
export type ReticulumMessagePostgres = typeof reticulumMessagesPostgres.$inferSelect;
export type NewReticulumMessagePostgres = typeof reticulumMessagesPostgres.$inferInsert;
export type ReticulumMessageMysql = typeof reticulumMessagesMysql.$inferSelect;
export type NewReticulumMessageMysql = typeof reticulumMessagesMysql.$inferInsert;
