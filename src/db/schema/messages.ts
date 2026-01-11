/**
 * Drizzle schema definition for the messages table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, text as myText } from 'drizzle-orm/mysql-core';
import { nodesSqlite, nodesPostgres, nodesMysql } from './nodes.js';

// SQLite schema
export const messagesSqlite = sqliteTable('messages', {
  id: text('id').primaryKey(),
  fromNodeNum: integer('fromNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: integer('toNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: text('fromNodeId').notNull(),
  toNodeId: text('toNodeId').notNull(),
  text: text('text').notNull(),
  channel: integer('channel').notNull().default(0),
  portnum: integer('portnum'),
  requestId: integer('requestId'),
  timestamp: integer('timestamp').notNull(),
  rxTime: integer('rxTime'),
  hopStart: integer('hopStart'),
  hopLimit: integer('hopLimit'),
  relayNode: integer('relayNode'),
  replyId: integer('replyId'),
  emoji: integer('emoji'),
  viaMqtt: integer('viaMqtt', { mode: 'boolean' }),
  rxSnr: real('rxSnr'),
  rxRssi: real('rxRssi'),
  // Delivery tracking
  ackFailed: integer('ackFailed', { mode: 'boolean' }),
  routingErrorReceived: integer('routingErrorReceived', { mode: 'boolean' }),
  deliveryState: text('deliveryState'),
  wantAck: integer('wantAck', { mode: 'boolean' }),
  ackFromNode: integer('ackFromNode'),
  createdAt: integer('createdAt').notNull(),
});

// PostgreSQL schema
export const messagesPostgres = pgTable('messages', {
  id: pgText('id').primaryKey(),
  fromNodeNum: pgBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  text: pgText('text').notNull(),
  channel: pgInteger('channel').notNull().default(0),
  portnum: pgInteger('portnum'),
  requestId: pgBigint('requestId', { mode: 'number' }),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  rxTime: pgBigint('rxTime', { mode: 'number' }),
  hopStart: pgInteger('hopStart'),
  hopLimit: pgInteger('hopLimit'),
  relayNode: pgInteger('relayNode'),
  replyId: pgBigint('replyId', { mode: 'number' }),
  emoji: pgInteger('emoji'),
  viaMqtt: pgBoolean('viaMqtt'),
  rxSnr: pgReal('rxSnr'),
  rxRssi: pgReal('rxRssi'),
  // Delivery tracking
  ackFailed: pgBoolean('ackFailed'),
  routingErrorReceived: pgBoolean('routingErrorReceived'),
  deliveryState: pgText('deliveryState'),
  wantAck: pgBoolean('wantAck'),
  ackFromNode: pgInteger('ackFromNode'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const messagesMysql = mysqlTable('messages', {
  id: myVarchar('id', { length: 64 }).primaryKey(),
  fromNodeNum: myBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: myBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: myVarchar('fromNodeId', { length: 32 }).notNull(),
  toNodeId: myVarchar('toNodeId', { length: 32 }).notNull(),
  text: myText('text').notNull(),
  channel: myInt('channel').notNull().default(0),
  portnum: myInt('portnum'),
  requestId: myBigint('requestId', { mode: 'number' }),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  rxTime: myBigint('rxTime', { mode: 'number' }),
  hopStart: myInt('hopStart'),
  hopLimit: myInt('hopLimit'),
  relayNode: myInt('relayNode'),
  replyId: myBigint('replyId', { mode: 'number' }),
  emoji: myInt('emoji'),
  viaMqtt: myBoolean('viaMqtt'),
  rxSnr: myDouble('rxSnr'),
  rxRssi: myDouble('rxRssi'),
  // Delivery tracking
  ackFailed: myBoolean('ackFailed'),
  routingErrorReceived: myBoolean('routingErrorReceived'),
  deliveryState: myVarchar('deliveryState', { length: 32 }),
  wantAck: myBoolean('wantAck'),
  ackFromNode: myInt('ackFromNode'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type MessageSqlite = typeof messagesSqlite.$inferSelect;
export type NewMessageSqlite = typeof messagesSqlite.$inferInsert;
export type MessagePostgres = typeof messagesPostgres.$inferSelect;
export type NewMessagePostgres = typeof messagesPostgres.$inferInsert;
export type MessageMysql = typeof messagesMysql.$inferSelect;
export type NewMessageMysql = typeof messagesMysql.$inferInsert;
