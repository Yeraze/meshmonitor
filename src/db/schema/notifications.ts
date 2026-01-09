/**
 * Drizzle schema definition for notification tables
 * Includes: push_subscriptions, user_notification_preferences, read_messages
 * Supports SQLite, PostgreSQL, and MySQL (MySQL uses PostgreSQL schema)
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { usersSqlite, usersPostgres } from './auth.js';

// ============ PUSH SUBSCRIPTIONS ============

export const pushSubscriptionsSqlite = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('userId').references(() => usersSqlite.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  p256dhKey: text('p256dhKey').notNull(),
  authKey: text('authKey').notNull(),
  userAgent: text('userAgent'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  lastUsedAt: integer('lastUsedAt'),
});

export const pushSubscriptionsPostgres = pgTable('push_subscriptions', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').references(() => usersPostgres.id, { onDelete: 'cascade' }),
  endpoint: pgText('endpoint').notNull(),
  p256dhKey: pgText('p256dhKey').notNull(),
  authKey: pgText('authKey').notNull(),
  userAgent: pgText('userAgent'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  lastUsedAt: pgBigint('lastUsedAt', { mode: 'number' }),
});

// ============ USER NOTIFICATION PREFERENCES ============

export const userNotificationPreferencesSqlite = sqliteTable('user_notification_preferences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('userId').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  notifyOnMessage: integer('notifyOnMessage', { mode: 'boolean' }).default(true),
  notifyOnDirectMessage: integer('notifyOnDirectMessage', { mode: 'boolean' }).default(true),
  notifyOnChannelMessage: integer('notifyOnChannelMessage', { mode: 'boolean' }).default(false),
  notifyOnEmoji: integer('notifyOnEmoji', { mode: 'boolean' }).default(false),
  notifyOnInactiveNode: integer('notifyOnInactiveNode', { mode: 'boolean' }).default(false),
  notifyOnServerEvents: integer('notifyOnServerEvents', { mode: 'boolean' }).default(false),
  prefixWithNodeName: integer('prefixWithNodeName', { mode: 'boolean' }).default(false),
  appriseEnabled: integer('appriseEnabled', { mode: 'boolean' }).default(true),
  appriseUrls: text('appriseUrls'),
  notifyOnMqtt: integer('notifyOnMqtt', { mode: 'boolean' }).default(true),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

export const userNotificationPreferencesPostgres = pgTable('user_notification_preferences', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  notifyOnMessage: pgBoolean('notifyOnMessage').default(true),
  notifyOnDirectMessage: pgBoolean('notifyOnDirectMessage').default(true),
  notifyOnChannelMessage: pgBoolean('notifyOnChannelMessage').default(false),
  notifyOnEmoji: pgBoolean('notifyOnEmoji').default(false),
  notifyOnInactiveNode: pgBoolean('notifyOnInactiveNode').default(false),
  notifyOnServerEvents: pgBoolean('notifyOnServerEvents').default(false),
  prefixWithNodeName: pgBoolean('prefixWithNodeName').default(false),
  appriseEnabled: pgBoolean('appriseEnabled').default(true),
  appriseUrls: pgText('appriseUrls'),
  notifyOnMqtt: pgBoolean('notifyOnMqtt').default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ READ MESSAGES ============

export const readMessagesSqlite = sqliteTable('read_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('userId').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  messageId: text('messageId').notNull(),
  readAt: integer('readAt').notNull(),
});

export const readMessagesPostgres = pgTable('read_messages', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  messageId: pgText('messageId').notNull(),
  readAt: pgBigint('readAt', { mode: 'number' }).notNull(),
});

// Type inference
export type PushSubscriptionSqlite = typeof pushSubscriptionsSqlite.$inferSelect;
export type NewPushSubscriptionSqlite = typeof pushSubscriptionsSqlite.$inferInsert;
export type PushSubscriptionPostgres = typeof pushSubscriptionsPostgres.$inferSelect;
export type NewPushSubscriptionPostgres = typeof pushSubscriptionsPostgres.$inferInsert;

export type UserNotificationPreferenceSqlite = typeof userNotificationPreferencesSqlite.$inferSelect;
export type NewUserNotificationPreferenceSqlite = typeof userNotificationPreferencesSqlite.$inferInsert;
export type UserNotificationPreferencePostgres = typeof userNotificationPreferencesPostgres.$inferSelect;
export type NewUserNotificationPreferencePostgres = typeof userNotificationPreferencesPostgres.$inferInsert;

export type ReadMessageSqlite = typeof readMessagesSqlite.$inferSelect;
export type NewReadMessageSqlite = typeof readMessagesSqlite.$inferInsert;
export type ReadMessagePostgres = typeof readMessagesPostgres.$inferSelect;
export type NewReadMessagePostgres = typeof readMessagesPostgres.$inferInsert;
