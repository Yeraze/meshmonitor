/**
 * MQTT-native ("nodeless") send identities (#4305).
 *
 * One row per MQTT source (mqtt_bridge / mqtt_broker) that has generated its
 * own Meshtastic identity: a node number derived from an X25519 public key the
 * way firmware 2.8 derives it (crc32 of the key), the public key in the clear,
 * and the private key sealed with the SESSION_SECRET-derived AES-256-GCM
 * envelope SourcePkiKeyStore uses. Listed in BACKUP_SECRET_TABLES.
 *
 * The row also carries the two pieces of send state that must survive a
 * restart or a settings save:
 *   - `lastNodeInfoAt` (ms): the last NodeInfo announce, so the 3-hour cadence
 *     is measured from the last real send, never from a boot or a save.
 *   - `sendTimes`: JSON array of the ms timestamps of the user sends inside the
 *     last hour, so a restart cannot reopen the hourly rate-limit window.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

export const mqttNativeIdentitiesSqlite = sqliteTable('mqtt_native_identities', {
  sourceId: text('sourceId').primaryKey(),
  nodeNum: integer('nodeNum').notNull(),
  publicKey: text('publicKey').notNull(),
  encryptedPrivateKey: text('encryptedPrivateKey').notNull(),
  lastNodeInfoAt: integer('lastNodeInfoAt'),
  sendTimes: text('sendTimes'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

export const mqttNativeIdentitiesPostgres = pgTable('mqtt_native_identities', {
  sourceId: pgText('sourceId').primaryKey(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  publicKey: pgText('publicKey').notNull(),
  encryptedPrivateKey: pgText('encryptedPrivateKey').notNull(),
  lastNodeInfoAt: pgBigint('lastNodeInfoAt', { mode: 'number' }),
  sendTimes: pgText('sendTimes'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

export const mqttNativeIdentitiesMysql = mysqlTable('mqtt_native_identities', {
  sourceId: myVarchar('sourceId', { length: 64 }).primaryKey(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  publicKey: myVarchar('publicKey', { length: 128 }).notNull(),
  encryptedPrivateKey: myText('encryptedPrivateKey').notNull(),
  lastNodeInfoAt: myBigint('lastNodeInfoAt', { mode: 'number' }),
  sendTimes: myText('sendTimes'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});
