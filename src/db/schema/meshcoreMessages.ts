/**
 * Drizzle schema definition for MeshCore messages table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, text as myText } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreMessagesSqlite = sqliteTable('meshcore_messages', {
  // Unique message ID (generated)
  id: text('id').primaryKey(),

  // Sender public key
  fromPublicKey: text('fromPublicKey').notNull(),

  // Recipient public key (null for broadcast)
  toPublicKey: text('toPublicKey'),

  // Message content
  text: text('text').notNull(),

  // Timestamp (Unix ms)
  timestamp: integer('timestamp').notNull(),

  // Signal quality at receive time
  rssi: integer('rssi'),
  snr: integer('snr'),

  // Message type (for future use: text, location, etc.)
  messageType: text('messageType').default('text'),

  // Delivery status
  delivered: integer('delivered', { mode: 'boolean' }).default(false),
  deliveredAt: integer('deliveredAt'),

  // Timestamps
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcoreMessagesPostgres = pgTable('meshcore_messages', {
  id: pgText('id').primaryKey(),
  fromPublicKey: pgText('fromPublicKey').notNull(),
  toPublicKey: pgText('toPublicKey'),
  text: pgText('text').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  rssi: pgInteger('rssi'),
  snr: pgInteger('snr'),
  messageType: pgText('messageType').default('text'),
  delivered: pgInteger('delivered'),
  deliveredAt: pgBigint('deliveredAt', { mode: 'number' }),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcoreMessagesMysql = mysqlTable('meshcore_messages', {
  id: myVarchar('id', { length: 64 }).primaryKey(),
  fromPublicKey: myVarchar('fromPublicKey', { length: 64 }).notNull(),
  toPublicKey: myVarchar('toPublicKey', { length: 64 }),
  text: myText('text').notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  rssi: myInt('rssi'),
  snr: myInt('snr'),
  messageType: myVarchar('messageType', { length: 32 }).default('text'),
  delivered: myInt('delivered'),
  deliveredAt: myBigint('deliveredAt', { mode: 'number' }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshCoreMessageSqlite = typeof meshcoreMessagesSqlite.$inferSelect;
export type NewMeshCoreMessageSqlite = typeof meshcoreMessagesSqlite.$inferInsert;
export type MeshCoreMessagePostgres = typeof meshcoreMessagesPostgres.$inferSelect;
export type NewMeshCoreMessagePostgres = typeof meshcoreMessagesPostgres.$inferInsert;
export type MeshCoreMessageMysql = typeof meshcoreMessagesMysql.$inferSelect;
export type NewMeshCoreMessageMysql = typeof meshcoreMessagesMysql.$inferInsert;
