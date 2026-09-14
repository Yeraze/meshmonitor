/**
 * Drizzle schema definition for notification tables
 * Includes: push_subscriptions, user_notification_preferences, read_messages
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real, primaryKey as sqlitePrimaryKey, uniqueIndex as sqliteUniqueIndex, index as sqliteIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint, doublePrecision as pgDouble, serial as pgSerial, primaryKey as pgPrimaryKey, uniqueIndex as pgUniqueIndex, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, boolean as myBoolean, bigint as myBigint, double as myDouble, serial as mySerial, primaryKey as myPrimaryKey, uniqueIndex as myUniqueIndex, index as myIndex } from 'drizzle-orm/mysql-core';
import { usersSqlite, usersPostgres, usersMysql } from './auth.js';

// ============ PUSH SUBSCRIPTIONS ============

export const pushSubscriptionsSqlite = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').references(() => usersSqlite.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dhKey: text('p256dh_key').notNull(),
  authKey: text('auth_key').notNull(),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastUsedAt: integer('last_used_at'),
}, (t) => ({
  userEndpointSource: sqliteUniqueIndex('idx_push_subscriptions_user_endpoint_source').on(t.userId, t.endpoint, t.sourceId),
  userSource: sqliteIndex('idx_push_subscriptions_user_source').on(t.userId, t.sourceId),
}));

export const pushSubscriptionsPostgres = pgTable('push_subscriptions', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').references(() => usersPostgres.id, { onDelete: 'cascade' }),
  sourceId: pgText('sourceId').notNull(),
  endpoint: pgText('endpoint').notNull(),
  p256dhKey: pgText('p256dhKey').notNull(),
  authKey: pgText('authKey').notNull(),
  userAgent: pgText('userAgent'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  lastUsedAt: pgBigint('lastUsedAt', { mode: 'number' }),
}, (t) => ({
  userEndpointSource: pgUniqueIndex('idx_push_subscriptions_user_endpoint_source').on(t.userId, t.endpoint, t.sourceId),
  userSource: pgIndex('idx_push_subscriptions_user_source').on(t.userId, t.sourceId),
}));

// ============ USER NOTIFICATION PREFERENCES ============

export const userNotificationPreferencesSqlite = sqliteTable('user_notification_preferences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  notifyOnMessage: integer('enable_web_push', { mode: 'boolean' }).default(true),
  notifyOnDirectMessage: integer('enable_direct_messages', { mode: 'boolean' }).default(true),
  notifyOnEmoji: integer('notify_on_emoji', { mode: 'boolean' }).default(false),
  notifyOnNewNode: integer('notify_on_new_node', { mode: 'boolean' }).default(true),
  notifyOnTraceroute: integer('notify_on_traceroute', { mode: 'boolean' }).default(true),
  notifyOnInactiveNode: integer('notify_on_inactive_node', { mode: 'boolean' }).default(false),
  notifyOnLowBattery: integer('notify_on_low_battery', { mode: 'boolean' }).default(false),
  lowBatteryThreshold: integer('low_battery_threshold').default(20),
  // MeshCore nodes report battery voltage (mV) rather than a 0-100 percentage,
  // so low-battery alerts for them trigger when batteryMv drops below this value.
  lowBatteryVoltageThreshold: integer('low_battery_voltage_threshold').default(3300),
  notifyOnServerEvents: integer('notify_on_server_events', { mode: 'boolean' }).default(false),
  // Waypoint arrival alerts (#4750). Opt-in like the two flags above it, with a
  // radius so a user hears about their own area rather than the whole mesh.
  // A NULL centre means "use this source's own node position".
  notifyOnWaypoint: integer('notify_on_waypoint', { mode: 'boolean' }).default(false),
  waypointRadiusKm: real('waypoint_radius_km').default(10),
  waypointCenterLat: real('waypoint_center_lat'),
  waypointCenterLon: real('waypoint_center_lon'),
  prefixWithNodeName: integer('prefix_with_node_name', { mode: 'boolean' }).default(false),
  appriseEnabled: integer('enable_apprise', { mode: 'boolean' }).default(true),
  appriseUrls: text('apprise_urls'),
  enabledChannels: text('enabled_channels'),
  monitoredNodes: text('monitored_nodes'),
  whitelist: text('whitelist'),
  blacklist: text('blacklist'),
  notifyOnMqtt: integer('notify_on_mqtt', { mode: 'boolean' }).default(true),
  mutedChannels: text('muted_channels'),
  mutedDMs: text('muted_dms'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  userSource: sqliteUniqueIndex('idx_user_notification_preferences_user_source').on(t.userId, t.sourceId),
}));

export const userNotificationPreferencesPostgres = pgTable('user_notification_preferences', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  sourceId: pgText('sourceId').notNull(),
  notifyOnMessage: pgBoolean('notifyOnMessage').default(true),
  notifyOnDirectMessage: pgBoolean('notifyOnDirectMessage').default(true),
  notifyOnChannelMessage: pgBoolean('notifyOnChannelMessage').default(false),
  notifyOnEmoji: pgBoolean('notifyOnEmoji').default(false),
  notifyOnNewNode: pgBoolean('notifyOnNewNode').default(true),
  notifyOnTraceroute: pgBoolean('notifyOnTraceroute').default(true),
  notifyOnInactiveNode: pgBoolean('notifyOnInactiveNode').default(false),
  notifyOnLowBattery: pgBoolean('notifyOnLowBattery').default(false),
  lowBatteryThreshold: pgInteger('lowBatteryThreshold').default(20),
  lowBatteryVoltageThreshold: pgInteger('lowBatteryVoltageThreshold').default(3300),
  notifyOnServerEvents: pgBoolean('notifyOnServerEvents').default(false),
  notifyOnWaypoint: pgBoolean('notifyOnWaypoint').default(false),
  waypointRadiusKm: pgDouble('waypointRadiusKm').default(10),
  waypointCenterLat: pgDouble('waypointCenterLat'),
  waypointCenterLon: pgDouble('waypointCenterLon'),
  prefixWithNodeName: pgBoolean('prefixWithNodeName').default(false),
  appriseEnabled: pgBoolean('appriseEnabled').default(true),
  appriseUrls: pgText('appriseUrls'),
  enabledChannels: pgText('enabledChannels'),
  monitoredNodes: pgText('monitoredNodes'),
  whitelist: pgText('whitelist'),
  blacklist: pgText('blacklist'),
  notifyOnMqtt: pgBoolean('notifyOnMqtt').default(true),
  mutedChannels: pgText('mutedChannels'),
  mutedDMs: pgText('mutedDMs'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  userSource: pgUniqueIndex('idx_user_notification_preferences_user_source').on(t.userId, t.sourceId),
}));

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
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  endpoint: myText('endpoint').notNull(),
  p256dhKey: myVarchar('p256dhKey', { length: 512 }).notNull(),
  authKey: myVarchar('authKey', { length: 128 }).notNull(),
  userAgent: myVarchar('userAgent', { length: 512 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  lastUsedAt: myBigint('lastUsedAt', { mode: 'number' }),
}, (t) => ({
  userSource: myIndex('idx_push_subscriptions_user_source').on(t.userId, t.sourceId),
}));

export const userNotificationPreferencesMysql = mysqlTable('user_notification_preferences', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  notifyOnMessage: myBoolean('notifyOnMessage').default(true),
  notifyOnDirectMessage: myBoolean('notifyOnDirectMessage').default(true),
  notifyOnChannelMessage: myBoolean('notifyOnChannelMessage').default(false),
  notifyOnEmoji: myBoolean('notifyOnEmoji').default(false),
  notifyOnNewNode: myBoolean('notifyOnNewNode').default(true),
  notifyOnTraceroute: myBoolean('notifyOnTraceroute').default(true),
  notifyOnInactiveNode: myBoolean('notifyOnInactiveNode').default(false),
  notifyOnLowBattery: myBoolean('notifyOnLowBattery').default(false),
  lowBatteryThreshold: myInt('lowBatteryThreshold').default(20),
  lowBatteryVoltageThreshold: myInt('lowBatteryVoltageThreshold').default(3300),
  notifyOnServerEvents: myBoolean('notifyOnServerEvents').default(false),
  notifyOnWaypoint: myBoolean('notifyOnWaypoint').default(false),
  waypointRadiusKm: myDouble('waypointRadiusKm').default(10),
  waypointCenterLat: myDouble('waypointCenterLat'),
  waypointCenterLon: myDouble('waypointCenterLon'),
  prefixWithNodeName: myBoolean('prefixWithNodeName').default(false),
  appriseEnabled: myBoolean('appriseEnabled').default(true),
  appriseUrls: myText('appriseUrls'),
  enabledChannels: myText('enabledChannels'),
  monitoredNodes: myText('monitoredNodes'),
  whitelist: myText('whitelist'),
  blacklist: myText('blacklist'),
  notifyOnMqtt: myBoolean('notifyOnMqtt').default(true),
  mutedChannels: myText('mutedChannels'),
  mutedDMs: myText('mutedDMs'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  userSource: myUniqueIndex('idx_user_notification_preferences_user_source').on(t.userId, t.sourceId),
}));

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


// ============ WAYPOINT NOTIFICATION LEDGER ============

/**
 * One row per (user, source, waypoint) already alerted on (#4750).
 *
 * The dedupe key is the waypoint id alone — deliberately not its name or
 * position. Waypoints do not move: a "moved" waypoint is a new one, created
 * with a fresh id, and SHOULD alert again. Keying on the id gives that for
 * free while a rebroadcast of an id already in this table stays silent.
 *
 * Rows are written only when an alert is actually sent, so a waypoint that
 * arrived out of range leaves no row and will alert if it comes back while the
 * user's reference point has moved closer. They are deleted when the waypoint
 * is deleted or expires, which both bounds the table and lets a recycled id
 * alert again.
 */
export const waypointNotificationsSqlite = sqliteTable('waypoint_notifications', {
  userId: integer('user_id').notNull(),
  sourceId: text('source_id').notNull(),
  waypointId: integer('waypoint_id').notNull(),
  notifiedAt: integer('notified_at').notNull(),
}, (t) => ({
  pk: sqlitePrimaryKey({ columns: [t.userId, t.sourceId, t.waypointId] }),
  sourceWaypoint: sqliteIndex('idx_waypoint_notifications_source_waypoint').on(t.sourceId, t.waypointId),
}));

export const waypointNotificationsPostgres = pgTable('waypoint_notifications', {
  userId: pgInteger('userId').notNull(),
  sourceId: pgText('sourceId').notNull(),
  waypointId: pgBigint('waypointId', { mode: 'number' }).notNull(),
  notifiedAt: pgBigint('notifiedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: pgPrimaryKey({ columns: [t.userId, t.sourceId, t.waypointId] }),
  sourceWaypoint: pgIndex('idx_waypoint_notifications_source_waypoint').on(t.sourceId, t.waypointId),
}));

export const waypointNotificationsMysql = mysqlTable('waypoint_notifications', {
  userId: myInt('userId').notNull(),
  // VARCHAR rather than TEXT: it is part of the primary key, and MySQL cannot
  // index a TEXT column without a prefix length.
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  waypointId: myBigint('waypointId', { mode: 'number' }).notNull(),
  notifiedAt: myBigint('notifiedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: myPrimaryKey({ columns: [t.userId, t.sourceId, t.waypointId] }),
  sourceWaypoint: myIndex('idx_waypoint_notifications_source_waypoint').on(t.sourceId, t.waypointId),
}));
