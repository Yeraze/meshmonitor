/**
 * Drizzle schema definition for notification tables
 * Includes: push_subscriptions, user_notification_preferences, read_messages
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, boolean as myBoolean, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';
import { usersSqlite, usersPostgres, usersMysql } from './auth.js';

// ============ PUSH SUBSCRIPTIONS ============

export const pushSubscriptionsSqlite = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => usersSqlite.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  p256dhKey: text('p256dh_key').notNull(),
  authKey: text('auth_key').notNull(),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastUsedAt: integer('last_used_at'),
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
  userId: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  notifyOnMessage: integer('enable_web_push', { mode: 'boolean' }).default(true),
  notifyOnDirectMessage: integer('enable_direct_messages', { mode: 'boolean' }).default(true),
  notifyOnEmoji: integer('notify_on_emoji', { mode: 'boolean' }).default(false),
  notifyOnNewNode: integer('notify_on_new_node', { mode: 'boolean' }).default(true),
  notifyOnTraceroute: integer('notify_on_traceroute', { mode: 'boolean' }).default(true),
  notifyOnInactiveNode: integer('notify_on_inactive_node', { mode: 'boolean' }).default(false),
  notifyOnServerEvents: integer('notify_on_server_events', { mode: 'boolean' }).default(false),
  prefixWithNodeName: integer('prefix_with_node_name', { mode: 'boolean' }).default(false),
  appriseEnabled: integer('enable_apprise', { mode: 'boolean' }).default(true),
  appriseUrls: text('apprise_urls'),
  enabledChannels: text('enabled_channels'),
  monitoredNodes: text('monitored_nodes'),
  whitelist: text('whitelist'),
  blacklist: text('blacklist'),
  notifyOnMqtt: integer('notify_on_mqtt', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const userNotificationPreferencesPostgres = pgTable('user_notification_preferences', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  notifyOnMessage: pgBoolean('notifyOnMessage').default(true),
  notifyOnDirectMessage: pgBoolean('notifyOnDirectMessage').default(true),
  notifyOnChannelMessage: pgBoolean('notifyOnChannelMessage').default(false),
  notifyOnEmoji: pgBoolean('notifyOnEmoji').default(false),
  notifyOnNewNode: pgBoolean('notifyOnNewNode').default(true),
  notifyOnTraceroute: pgBoolean('notifyOnTraceroute').default(true),
  notifyOnInactiveNode: pgBoolean('notifyOnInactiveNode').default(false),
  notifyOnServerEvents: pgBoolean('notifyOnServerEvents').default(false),
  prefixWithNodeName: pgBoolean('prefixWithNodeName').default(false),
  appriseEnabled: pgBoolean('appriseEnabled').default(true),
  appriseUrls: pgText('appriseUrls'),
  enabledChannels: pgText('enabledChannels'),
  monitoredNodes: pgText('monitoredNodes'),
  whitelist: pgText('whitelist'),
  blacklist: pgText('blacklist'),
  notifyOnMqtt: pgBoolean('notifyOnMqtt').default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ READ MESSAGES ============

export const readMessagesSqlite = sqliteTable('read_messages', {
  messageId: text('message_id').notNull().primaryKey(),
  userId: integer('user_id').references(() => usersSqlite.id, { onDelete: 'cascade' }),
  readAt: integer('read_at').notNull(),
});

export const readMessagesPostgres = pgTable('read_messages', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  messageId: pgText('messageId').notNull(),
  readAt: pgBigint('readAt', { mode: 'number' }).notNull(),
});

// ============ MYSQL SCHEMAS ============

export const pushSubscriptionsMysql = mysqlTable('push_subscriptions', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').references(() => usersMysql.id, { onDelete: 'cascade' }),
  endpoint: myText('endpoint').notNull(),
  p256dhKey: myVarchar('p256dhKey', { length: 512 }).notNull(),
  authKey: myVarchar('authKey', { length: 128 }).notNull(),
  userAgent: myVarchar('userAgent', { length: 512 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  lastUsedAt: myBigint('lastUsedAt', { mode: 'number' }),
});

export const userNotificationPreferencesMysql = mysqlTable('user_notification_preferences', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  notifyOnMessage: myBoolean('notifyOnMessage').default(true),
  notifyOnDirectMessage: myBoolean('notifyOnDirectMessage').default(true),
  notifyOnChannelMessage: myBoolean('notifyOnChannelMessage').default(false),
  notifyOnEmoji: myBoolean('notifyOnEmoji').default(false),
  notifyOnNewNode: myBoolean('notifyOnNewNode').default(true),
  notifyOnTraceroute: myBoolean('notifyOnTraceroute').default(true),
  notifyOnInactiveNode: myBoolean('notifyOnInactiveNode').default(false),
  notifyOnServerEvents: myBoolean('notifyOnServerEvents').default(false),
  prefixWithNodeName: myBoolean('prefixWithNodeName').default(false),
  appriseEnabled: myBoolean('appriseEnabled').default(true),
  appriseUrls: myText('appriseUrls'),
  enabledChannels: myText('enabledChannels'),
  monitoredNodes: myText('monitoredNodes'),
  whitelist: myText('whitelist'),
  blacklist: myText('blacklist'),
  notifyOnMqtt: myBoolean('notifyOnMqtt').default(true),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export const readMessagesMysql = mysqlTable('read_messages', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  messageId: myVarchar('messageId', { length: 64 }).notNull(),
  readAt: myBigint('readAt', { mode: 'number' }).notNull(),
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
export type ReadMessageMysql = typeof readMessagesMysql.$inferSelect;
export type NewReadMessageMysql = typeof readMessagesMysql.$inferInsert;

export type PushSubscriptionMysql = typeof pushSubscriptionsMysql.$inferSelect;
export type NewPushSubscriptionMysql = typeof pushSubscriptionsMysql.$inferInsert;
export type UserNotificationPreferenceMysql = typeof userNotificationPreferencesMysql.$inferSelect;
export type NewUserNotificationPreferenceMysql = typeof userNotificationPreferencesMysql.$inferInsert;
