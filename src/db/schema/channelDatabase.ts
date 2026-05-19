/**
 * Drizzle schema definition for the channel_database tables
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * This enables MeshMonitor to store additional channel configurations beyond
 * the device's 8 slots and decrypt packets server-side using stored keys.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  boolean as pgBoolean,
  bigint as pgBigint,
  serial as pgSerial,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  text as myText,
  int as myInt,
  boolean as myBoolean,
  bigint as myBigint,
  serial as mySerial,
} from 'drizzle-orm/mysql-core';
import { usersSqlite, usersPostgres, usersMysql } from './auth.js';

// ============ CHANNEL DATABASE (SQLite) ============

export const channelDatabaseSqlite = sqliteTable('channel_database', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  psk: text('psk').notNull(), // Base64-encoded PSK
  pskLength: integer('psk_length').notNull(), // 16 for AES-128, 32 for AES-256
  description: text('description'),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
  enforceNameValidation: integer('enforce_name_validation', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0), // Order for decryption priority
  decryptedPacketCount: integer('decrypted_packet_count').notNull().default(0),
  lastDecryptedAt: integer('last_decrypted_at'),
  createdBy: integer('created_by').references(() => usersSqlite.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ============ CHANNEL DATABASE PERMISSIONS (SQLite) ============

export const channelDatabasePermissionsSqlite = sqliteTable('channel_database_permissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => usersSqlite.id, { onDelete: 'cascade' }),
  channelDatabaseId: integer('channel_database_id')
    .notNull()
    .references(() => channelDatabaseSqlite.id, { onDelete: 'cascade' }),
  canViewOnMap: integer('can_view_on_map', { mode: 'boolean' }).notNull().default(false),
  canRead: integer('can_read', { mode: 'boolean' }).notNull().default(false),
  grantedBy: integer('granted_by').references(() => usersSqlite.id, { onDelete: 'set null' }),
  grantedAt: integer('granted_at').notNull(),
});

// ============ CHANNEL DATABASE (PostgreSQL) ============

export const channelDatabasePostgres = pgTable('channel_database', {
  id: pgSerial('id').primaryKey(),
  name: pgText('name').notNull(),
  psk: pgText('psk').notNull(), // Base64-encoded PSK
  pskLength: pgInteger('pskLength').notNull(), // 16 for AES-128, 32 for AES-256
  description: pgText('description'),
  isEnabled: pgBoolean('isEnabled').notNull().default(true),
  enforceNameValidation: pgBoolean('enforceNameValidation').notNull().default(false),
  sortOrder: pgInteger('sortOrder').notNull().default(0), // Order for decryption priority
  decryptedPacketCount: pgInteger('decryptedPacketCount').notNull().default(0),
  lastDecryptedAt: pgBigint('lastDecryptedAt', { mode: 'number' }),
  createdBy: pgInteger('createdBy').references(() => usersPostgres.id, { onDelete: 'set null' }),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ CHANNEL DATABASE PERMISSIONS (PostgreSQL) ============

export const channelDatabasePermissionsPostgres = pgTable('channel_database_permissions', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId')
    .notNull()
    .references(() => usersPostgres.id, { onDelete: 'cascade' }),
  channelDatabaseId: pgInteger('channelDatabaseId')
    .notNull()
    .references(() => channelDatabasePostgres.id, { onDelete: 'cascade' }),
  canViewOnMap: pgBoolean('canViewOnMap').notNull().default(false),
  canRead: pgBoolean('canRead').notNull().default(false),
  grantedBy: pgInteger('grantedBy').references(() => usersPostgres.id, { onDelete: 'set null' }),
  grantedAt: pgBigint('grantedAt', { mode: 'number' }).notNull(),
});

// ============ CHANNEL DATABASE (MySQL) ============

export const channelDatabaseMysql = mysqlTable('channel_database', {
  id: mySerial('id').primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  psk: myVarchar('psk', { length: 255 }).notNull(), // Base64-encoded PSK
  pskLength: myInt('pskLength').notNull(), // 16 for AES-128, 32 for AES-256
  description: myText('description'),
  isEnabled: myBoolean('isEnabled').notNull().default(true),
  enforceNameValidation: myBoolean('enforceNameValidation').notNull().default(false),
  sortOrder: myInt('sortOrder').notNull().default(0), // Order for decryption priority
  decryptedPacketCount: myInt('decryptedPacketCount').notNull().default(0),
  lastDecryptedAt: myBigint('lastDecryptedAt', { mode: 'number' }),
  createdBy: myInt('createdBy').references(() => usersMysql.id, { onDelete: 'set null' }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ CHANNEL DATABASE PERMISSIONS (MySQL) ============

export const channelDatabasePermissionsMysql = mysqlTable('channel_database_permissions', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId')
    .notNull()
    .references(() => usersMysql.id, { onDelete: 'cascade' }),
  channelDatabaseId: myInt('channelDatabaseId')
    .notNull()
    .references(() => channelDatabaseMysql.id, { onDelete: 'cascade' }),
  canViewOnMap: myBoolean('canViewOnMap').notNull().default(false),
  canRead: myBoolean('canRead').notNull().default(false),
  grantedBy: myInt('grantedBy').references(() => usersMysql.id, { onDelete: 'set null' }),
  grantedAt: myBigint('grantedAt', { mode: 'number' }).notNull(),
});

// ============ TYPE INFERENCE ============

// Channel Database types
export type ChannelDatabaseSqlite = typeof channelDatabaseSqlite.$inferSelect;
export type NewChannelDatabaseSqlite = typeof channelDatabaseSqlite.$inferInsert;
export type ChannelDatabasePostgres = typeof channelDatabasePostgres.$inferSelect;
export type NewChannelDatabasePostgres = typeof channelDatabasePostgres.$inferInsert;
export type ChannelDatabaseMysql = typeof channelDatabaseMysql.$inferSelect;
export type NewChannelDatabaseMysql = typeof channelDatabaseMysql.$inferInsert;

// Channel Database Permissions types
export type ChannelDatabasePermissionSqlite = typeof channelDatabasePermissionsSqlite.$inferSelect;
export type NewChannelDatabasePermissionSqlite = typeof channelDatabasePermissionsSqlite.$inferInsert;
export type ChannelDatabasePermissionPostgres = typeof channelDatabasePermissionsPostgres.$inferSelect;
export type NewChannelDatabasePermissionPostgres = typeof channelDatabasePermissionsPostgres.$inferInsert;
export type ChannelDatabasePermissionMysql = typeof channelDatabasePermissionsMysql.$inferSelect;
export type NewChannelDatabasePermissionMysql = typeof channelDatabasePermissionsMysql.$inferInsert;
