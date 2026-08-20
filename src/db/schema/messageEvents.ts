/**
 * Drizzle schema for the `message_events` table (#4816 Phase 3).
 *
 * Persists a per-message delivery event timeline: submitted / sent_to_radio /
 * delivered / confirmed / routing_error / timeout / retry. Protocol-agnostic —
 * one table serves both Meshtastic (`messages.id`) and MeshCore
 * (`meshcore_messages.id`) since both already carry a stable string message id.
 *
 * Linking key is `(sourceId, messageId)`, deliberately NOT `requestId` — the
 * message id is stable across retries while a requestId rotates per attempt.
 * This matches `meshcore_heard_repeaters` exactly: same fetch shape, same
 * per-source scoping, same ms-timestamp typing (`bigint({mode:'number'})` on
 * PG/MySQL).
 *
 * A side table (rather than a JSON column on `messages`/`meshcore_messages`)
 * keeps the append-only event list normalized and avoids read-modify-write
 * races as events stream in from multiple async send/ack callbacks.
 *
 * PER-SOURCE (`sourceId`, scoped) — mandatory per the per-source isolation
 * hard rule; `sourceId` is required on every row.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const messageEventsSqlite = sqliteTable('message_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Owning source.
  sourceId: text('sourceId').notNull(),
  // FK-ish to messages.id (Meshtastic) / meshcore_messages.id (MeshCore).
  messageId: text('messageId').notNull(),
  // 'submitted' | 'sent_to_radio' | 'delivered' | 'confirmed' | 'routing_error' | 'timeout' | 'retry'
  eventType: text('eventType').notNull(),
  // 'reported' | 'observed' | 'inferred'
  provenance: text('provenance').notNull(),
  // Short JSON string: {routingErrorCode, attempt, ackFromNode, roundTripMs, reason} — only relevant keys.
  detail: text('detail'),
  // Unix ms the event occurred.
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const messageEventsPostgres = pgTable('message_events', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  messageId: pgText('messageId').notNull(),
  eventType: pgText('eventType').notNull(),
  provenance: pgText('provenance').notNull(),
  detail: pgText('detail'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const messageEventsMysql = mysqlTable('message_events', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  messageId: myVarchar('messageId', { length: 64 }).notNull(),
  eventType: myVarchar('eventType', { length: 24 }).notNull(),
  provenance: myVarchar('provenance', { length: 12 }).notNull(),
  detail: myText('detail'),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MessageEventSqlite = typeof messageEventsSqlite.$inferSelect;
export type NewMessageEventSqlite = typeof messageEventsSqlite.$inferInsert;
export type MessageEventPostgres = typeof messageEventsPostgres.$inferSelect;
export type NewMessageEventPostgres = typeof messageEventsPostgres.$inferInsert;
export type MessageEventMysql = typeof messageEventsMysql.$inferSelect;
export type NewMessageEventMysql = typeof messageEventsMysql.$inferInsert;
