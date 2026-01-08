/**
 * Drizzle schema definition for the messages table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { nodesSqlite, nodesPostgres } from './nodes.js';

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
  fromNodeNum: pgInteger('fromNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgInteger('toNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  text: pgText('text').notNull(),
  channel: pgInteger('channel').notNull().default(0),
  portnum: pgInteger('portnum'),
  requestId: pgInteger('requestId'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  rxTime: pgBigint('rxTime', { mode: 'number' }),
  hopStart: pgInteger('hopStart'),
  hopLimit: pgInteger('hopLimit'),
  relayNode: pgInteger('relayNode'),
  replyId: pgInteger('replyId'),
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

// Type inference
export type MessageSqlite = typeof messagesSqlite.$inferSelect;
export type NewMessageSqlite = typeof messagesSqlite.$inferInsert;
export type MessagePostgres = typeof messagesPostgres.$inferSelect;
export type NewMessagePostgres = typeof messagesPostgres.$inferInsert;
