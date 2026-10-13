/**
 * Drizzle schema definition for MeshCore messages table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, text as myText } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreMessagesSqlite = sqliteTable('meshcore_messages', {
  // Unique message ID (generated)
  id: text('id').primaryKey(),

  // Sender public key
  fromPublicKey: text('fromPublicKey').notNull(),

  // Display name of the sender (channel messages only; parsed from the "Name: body" prefix)
  fromName: text('fromName'),

  // Recipient public key (null for broadcast)
  toPublicKey: text('toPublicKey'),

  // Message content
  text: text('text').notNull(),

  // Timestamp (Unix ms)
  timestamp: integer('timestamp').notNull(),

  // Signal quality at receive time. rssi is a plain signed dBm byte
  // (integer); snr is a quarter-dB LoRa value (fractional, e.g. -8.25) per
  // the MeshCore companion wire format — see meshcoreCompanionCodec.ts.
  rssi: integer('rssi'),
  snr: real('snr'),
  // Routing metadata for received messages (#3742): hop count (from path_len)
  // and the comma-separated relay-hash chain (e.g. "a3,7f,02"). Null = direct/unknown.
  hopCount: integer('hopCount'),
  routePath: text('routePath'),

  // Scope/region (#3742 Phase 2). scopeCode = the packet's transport_code_1
  // (0 = sent unscoped, NULL = no scope info available). scopeName = the region
  // name resolved against known scopes at receive time (NULL = unscoped/unknown).
  scopeCode: integer('scopeCode'),
  scopeName: text('scopeName'),

  // Wire sender_timestamp (epoch SECONDS) of this message, any direction.
  // Migration 187 (#5512) first stored it for our own channel sends so a
  // resend can reuse it; #5759 (migration 203) also writes it on received
  // rows and own DMs. NULL for rows written before, and for room posts.
  senderTimestamp: integer('senderTimestamp'),

  // Reactions (#5759, migration 203). mc1Hash = MC1 reaction hash of this
  // message (ordinary rows only). The reaction* columns are set on reaction
  // rows; reactionEmoji non-NULL means "this row is a reaction" and `text`
  // holds the emoji. reactionTargetId = id of the target row on the same
  // source (NULL = unmatched).
  mc1Hash: text('mc1Hash'),
  reactionEmoji: text('reactionEmoji'),
  reactionFormat: text('reactionFormat'),
  reactionTargetHash: text('reactionTargetHash'),
  reactionTargetSender: text('reactionTargetSender'),
  reactionTargetId: text('reactionTargetId'),
  reactionRawText: text('reactionRawText'),

  // Decrypt provenance (#5551, migration 191). Set only when this source
  // decrypted a channel message with a key held by ANOTHER source; reads gate
  // the row on access to that key. keyFingerprint = hex SHA-256(secret)[0..8].
  keySourceId: text('keySourceId'),
  keyChannelIdx: integer('keyChannelIdx'),
  keyFingerprint: text('keyFingerprint'),

  // Message type (for future use: text, location, etc.)
  messageType: text('messageType').default('text'),

  // Delivery status
  delivered: integer('delivered', { mode: 'boolean' }).default(false),
  deliveredAt: integer('deliveredAt'),

  // Owning source (nullable for legacy single-source rows; backfilled by migration 056)
  sourceId: text('sourceId'),

  // Timestamps
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcoreMessagesPostgres = pgTable('meshcore_messages', {
  id: pgText('id').primaryKey(),
  fromPublicKey: pgText('fromPublicKey').notNull(),
  fromName: pgText('fromName'),
  toPublicKey: pgText('toPublicKey'),
  text: pgText('text').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  rssi: pgInteger('rssi'),
  snr: pgReal('snr'),
  hopCount: pgInteger('hopCount'),
  routePath: pgText('routePath'),
  scopeCode: pgInteger('scopeCode'),
  scopeName: pgText('scopeName'),
  senderTimestamp: pgBigint('senderTimestamp', { mode: 'number' }),
  mc1Hash: pgText('mc1Hash'),
  reactionEmoji: pgText('reactionEmoji'),
  reactionFormat: pgText('reactionFormat'),
  reactionTargetHash: pgText('reactionTargetHash'),
  reactionTargetSender: pgText('reactionTargetSender'),
  reactionTargetId: pgText('reactionTargetId'),
  reactionRawText: pgText('reactionRawText'),
  keySourceId: pgText('keySourceId'),
  keyChannelIdx: pgInteger('keyChannelIdx'),
  keyFingerprint: pgText('keyFingerprint'),
  messageType: pgText('messageType').default('text'),
  delivered: pgBoolean('delivered').default(false),
  deliveredAt: pgBigint('deliveredAt', { mode: 'number' }),
  sourceId: pgText('sourceId'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcoreMessagesMysql = mysqlTable('meshcore_messages', {
  id: myVarchar('id', { length: 64 }).primaryKey(),
  fromPublicKey: myVarchar('fromPublicKey', { length: 64 }).notNull(),
  fromName: myVarchar('fromName', { length: 64 }),
  toPublicKey: myVarchar('toPublicKey', { length: 64 }),
  text: myText('text').notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  rssi: myInt('rssi'),
  snr: myDouble('snr'),
  hopCount: myInt('hopCount'),
  routePath: myText('routePath'),
  scopeCode: myInt('scopeCode'),
  scopeName: myText('scopeName'),
  senderTimestamp: myBigint('senderTimestamp', { mode: 'number' }),
  mc1Hash: myVarchar('mc1Hash', { length: 8 }),
  reactionEmoji: myVarchar('reactionEmoji', { length: 64 }),
  reactionFormat: myVarchar('reactionFormat', { length: 24 }),
  reactionTargetHash: myVarchar('reactionTargetHash', { length: 64 }),
  reactionTargetSender: myText('reactionTargetSender'),
  reactionTargetId: myVarchar('reactionTargetId', { length: 64 }),
  reactionRawText: myText('reactionRawText'),
  keySourceId: myVarchar('keySourceId', { length: 64 }),
  keyChannelIdx: myInt('keyChannelIdx'),
  keyFingerprint: myVarchar('keyFingerprint', { length: 32 }),
  messageType: myVarchar('messageType', { length: 32 }).default('text'),
  delivered: myBoolean('delivered').default(false),
  deliveredAt: myBigint('deliveredAt', { mode: 'number' }),
  sourceId: myVarchar('sourceId', { length: 64 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshCoreMessageSqlite = typeof meshcoreMessagesSqlite.$inferSelect;
export type NewMeshCoreMessageSqlite = typeof meshcoreMessagesSqlite.$inferInsert;
export type MeshCoreMessagePostgres = typeof meshcoreMessagesPostgres.$inferSelect;
export type NewMeshCoreMessagePostgres = typeof meshcoreMessagesPostgres.$inferInsert;
export type MeshCoreMessageMysql = typeof meshcoreMessagesMysql.$inferSelect;
export type NewMeshCoreMessageMysql = typeof meshcoreMessagesMysql.$inferInsert;
