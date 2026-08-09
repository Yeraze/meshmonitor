/**
 * Drizzle schema for `conversation_read_state` (issue #4607).
 *
 * A durable, PER-USER "last read" watermark for one conversation on one
 * source. It answers "what had this operator already seen when they last left
 * this thread?", which is what the unread divider and the jump-to-first-unread
 * entry scroll both anchor on.
 *
 * Why a watermark table and not more `read_messages` rows: MeshCore messages
 * were never covered by Meshtastic's per-message `read_messages` join, so the
 * MeshCore views tracked their markers in `localStorage`, keyed only by
 * sourceId. That is per-BROWSER, not per-USER — on a multi-user install two
 * operators sharing a browser shared one set of markers, and the same operator
 * on a second device started from zero. This table moves that state server-side
 * where the user identity actually lives.
 *
 * Meshtastic deliberately does NOT write here: `read_messages` is already a
 * durable per-user record, and a second watermark would be a second source of
 * truth that "Mark all read" could silently desynchronise. Meshtastic derives
 * its divider anchor from `read_messages` instead (see
 * `NotificationsRepository.getFirstUnreadTimestampsAsync`).
 *
 * `userId` is NOT a foreign key and uses `0` for the anonymous / no-auth
 * operator. A nullable column cannot participate in the UNIQUE constraint the
 * upsert depends on (SQLite and PostgreSQL both treat NULLs as distinct, so
 * every write would append a new row), and a sentinel keeps the uniqueness
 * total. Orphan rows after a user delete are inert bookkeeping.
 */
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint as pgBigint,
  serial as pgSerial,
  uniqueIndex as pgUniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  int as myInt,
  bigint as myBigint,
  serial as mySerial,
  uniqueIndex as myUniqueIndex,
} from 'drizzle-orm/mysql-core';

/** Conversation families tracked by the watermark table. */
export const CONVERSATION_KINDS = ['meshcore_channel', 'meshcore_dm'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** Sentinel `userId` for the anonymous / unauthenticated operator. */
export const ANONYMOUS_USER_ID = 0;

// SQLite
export const conversationReadStateSqlite = sqliteTable('conversation_read_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  sourceId: text('source_id').notNull(),
  conversationKind: text('conversation_kind').notNull(),
  conversationKey: text('conversation_key').notNull(),
  lastReadAt: integer('last_read_at').notNull(),
}, (t) => ({
  uniqueConversation: uniqueIndex('idx_conversation_read_state_unique')
    .on(t.userId, t.sourceId, t.conversationKind, t.conversationKey),
}));

// PostgreSQL
export const conversationReadStatePostgres = pgTable('conversation_read_state', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull(),
  sourceId: pgText('sourceId').notNull(),
  conversationKind: pgText('conversationKind').notNull(),
  conversationKey: pgText('conversationKey').notNull(),
  lastReadAt: pgBigint('lastReadAt', { mode: 'number' }).notNull(),
}, (t) => ({
  uniqueConversation: pgUniqueIndex('idx_conversation_read_state_unique')
    .on(t.userId, t.sourceId, t.conversationKind, t.conversationKey),
}));

// MySQL
export const conversationReadStateMysql = mysqlTable('conversation_read_state', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  conversationKind: myVarchar('conversationKind', { length: 32 }).notNull(),
  // 64-hex MeshCore pubkeys are the longest key in practice; the index below
  // needs a bounded column, so this is a varchar rather than TEXT.
  conversationKey: myVarchar('conversationKey', { length: 128 }).notNull(),
  lastReadAt: myBigint('lastReadAt', { mode: 'number' }).notNull(),
}, (t) => ({
  uniqueConversation: myUniqueIndex('idx_conversation_read_state_unique')
    .on(t.userId, t.sourceId, t.conversationKind, t.conversationKey),
}));

export type ConversationReadStateSqlite = typeof conversationReadStateSqlite.$inferSelect;
export type NewConversationReadStateSqlite = typeof conversationReadStateSqlite.$inferInsert;
export type ConversationReadStatePostgres = typeof conversationReadStatePostgres.$inferSelect;
export type ConversationReadStateMysql = typeof conversationReadStateMysql.$inferSelect;
