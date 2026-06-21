/**
 * Drizzle schema for the Dead Drop / Mailbox feature.
 *
 * An async message store: a node DMs the MeshMonitor radio `msg <name> <text>`
 * and the message is held until the named recipient retrieves it with `inbox`
 * / `inbox play`. Think mesh voicemail — the recipient need not be online when
 * the message is sent.
 *
 * One table, per-source (each connected radio keeps its own mailbox):
 *
 *  - dead_drop_messages: one row per stored message. `recipientName` is the
 *    name as typed by the sender, normalized to lowercase; retrieval matches it
 *    against any identity form (short name, long name, node id, node num) of the
 *    DM sender asking for their inbox. `shortId` is the 4-char user-facing code
 *    used by `inbox delete <id>`. `playedAt` / `deletedAt` are soft-state: a
 *    message is "pending" until played, and hidden once deleted; expiry is
 *    enforced by filtering on `createdAt` in queries and purged by maintenance.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import { sqliteTable, text, integer, uniqueIndex as sqliteUniqueIndex, index as sqliteIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, uniqueIndex as pgUniqueIndex, index as pgIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint, serial as mySerial, uniqueIndex as myUniqueIndex, index as myIndex } from 'drizzle-orm/mysql-core';

// ============================ dead_drop_messages ============================

// SQLite
export const deadDropMessagesSqlite = sqliteTable('dead_drop_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  shortId: text('shortId').notNull(),
  recipientName: text('recipientName').notNull(),
  senderNodeNum: integer('senderNodeNum').notNull(),
  senderShortName: text('senderShortName').notNull().default(''),
  senderLongName: text('senderLongName').notNull().default(''),
  body: text('body').notNull(),
  createdAt: integer('createdAt').notNull(),
  playedAt: integer('playedAt'),
  deletedAt: integer('deletedAt'),
}, (table) => ({
  shortIdUniq: sqliteUniqueIndex('ddm_source_shortid_uniq').on(table.sourceId, table.shortId),
  recipientIdx: sqliteIndex('ddm_source_recipient_idx').on(table.sourceId, table.recipientName),
}));

// PostgreSQL
export const deadDropMessagesPostgres = pgTable('dead_drop_messages', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  shortId: pgText('shortId').notNull(),
  recipientName: pgText('recipientName').notNull(),
  senderNodeNum: pgBigint('senderNodeNum', { mode: 'number' }).notNull(),
  senderShortName: pgText('senderShortName').notNull().default(''),
  senderLongName: pgText('senderLongName').notNull().default(''),
  body: pgText('body').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  playedAt: pgBigint('playedAt', { mode: 'number' }),
  deletedAt: pgBigint('deletedAt', { mode: 'number' }),
}, (table) => ({
  shortIdUniq: pgUniqueIndex('ddm_source_shortid_uniq').on(table.sourceId, table.shortId),
  recipientIdx: pgIndex('ddm_source_recipient_idx').on(table.sourceId, table.recipientName),
}));

// MySQL
export const deadDropMessagesMysql = mysqlTable('dead_drop_messages', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  shortId: myVarchar('shortId', { length: 16 }).notNull(),
  recipientName: myVarchar('recipientName', { length: 64 }).notNull(),
  senderNodeNum: myBigint('senderNodeNum', { mode: 'number' }).notNull(),
  senderShortName: myVarchar('senderShortName', { length: 64 }).notNull().default(''),
  senderLongName: myVarchar('senderLongName', { length: 128 }).notNull().default(''),
  body: myText('body').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  playedAt: myBigint('playedAt', { mode: 'number' }),
  deletedAt: myBigint('deletedAt', { mode: 'number' }),
}, (table) => ({
  shortIdUniq: myUniqueIndex('ddm_source_shortid_uniq').on(table.sourceId, table.shortId),
  recipientIdx: myIndex('ddm_source_recipient_idx').on(table.sourceId, table.recipientName),
}));

// Type inference
export type DeadDropMessageSqlite = typeof deadDropMessagesSqlite.$inferSelect;
export type DeadDropMessageInsertSqlite = typeof deadDropMessagesSqlite.$inferInsert;
