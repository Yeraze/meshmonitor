/**
 * Drizzle schema for `mqtt_broker_presets` (issue #5794): MQTT brokers an
 * admin saved so any Meshtastic MQTT form can fill them in.
 *
 * GLOBAL by design (no sourceId): one broker is reused by many sources, which
 * is the point of saving it. Only admins write rows. Anyone who can edit a
 * source or a device's config may read them, but never `username`/`password`:
 * the server copies those into a config on save (services/mqttBrokerPresetFill.ts).
 *
 * `password` is stored as typed, like every MQTT password in `sources.config`.
 */
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  boolean as pgBoolean,
  bigint as pgBigint,
  serial as pgSerial,
  uniqueIndex as pgUniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  int as myInt,
  boolean as myBoolean,
  bigint as myBigint,
  uniqueIndex as myUniqueIndex,
} from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const mqttBrokerPresetsSqlite = sqliteTable('mqtt_broker_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  tls: integer('tls', { mode: 'boolean' }).notNull().default(false),
  username: text('username'),
  password: text('password'),
  rootTopic: text('rootTopic'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
}, (t) => ({
  nameUniq: uniqueIndex('mqtt_broker_presets_name_idx').on(t.name),
}));

// ============ PostgreSQL Schema ============

export const mqttBrokerPresetsPostgres = pgTable('mqtt_broker_presets', {
  id: pgSerial('id').primaryKey(),
  name: pgText('name').notNull(),
  host: pgText('host').notNull(),
  port: pgInteger('port').notNull(),
  tls: pgBoolean('tls').notNull().default(false),
  username: pgText('username'),
  password: pgText('password'),
  rootTopic: pgText('rootTopic'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  nameUniq: pgUniqueIndex('mqtt_broker_presets_name_idx').on(t.name),
}));

// ============ MySQL Schema ============

export const mqttBrokerPresetsMysql = mysqlTable('mqtt_broker_presets', {
  id: myInt('id').autoincrement().primaryKey(),
  name: myVarchar('name', { length: 64 }).notNull(),
  host: myVarchar('host', { length: 255 }).notNull(),
  port: myInt('port').notNull(),
  tls: myBoolean('tls').notNull().default(false),
  username: myVarchar('username', { length: 255 }),
  password: myVarchar('password', { length: 255 }),
  rootTopic: myVarchar('rootTopic', { length: 255 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  nameUniq: myUniqueIndex('mqtt_broker_presets_name_idx').on(t.name),
}));

// ============ Type Inference ============

export type MqttBrokerPresetSqlite = typeof mqttBrokerPresetsSqlite.$inferSelect;
export type MqttBrokerPresetPostgres = typeof mqttBrokerPresetsPostgres.$inferSelect;
export type MqttBrokerPresetMysql = typeof mqttBrokerPresetsMysql.$inferSelect;
