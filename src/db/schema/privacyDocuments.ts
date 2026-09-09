/**
 * Drizzle schema for operator-hosted privacy documents (#5156).
 * Supports SQLite, PostgreSQL, and MySQL.
 *
 * `privacy_documents` is GLOBAL by design (no sourceId). A privacy policy,
 * terms-of-service or contact page describes the MeshMonitor *deployment* —
 * the legal entity serving the dashboard — not any one mesh source. An
 * operator running four sources publishes one policy, the same way they set
 * one `noIndexEnabled`. This mirrors the global-by-design tables
 * `channel_database` and `automations`.
 *
 * One row per `slug` ('privacy' | 'terms' | 'contact'), so `slug` is UNIQUE
 * and doubles as the public URL segment (`/privacy/:slug`).
 *
 * `content` is **Markdown source, never HTML**. It is rendered client-side by
 * `react-markdown` with raw HTML passthrough disabled, which is what keeps an
 * operator-uploaded document from becoming stored XSS on an origin that
 * anonymous visitors and embed viewers load. Storing HTML here would defeat
 * that; see `PrivacyDocumentPage.tsx`.
 *
 * `content` is LONGTEXT on MySQL, not TEXT. MySQL's TEXT caps at 64 KiB and
 * truncates silently in non-strict mode — a half-saved privacy policy is
 * worse than a missing one, and the route's own cap (256 KiB) sits above
 * 64 KiB deliberately.
 */
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, longtext as myLongtext, uniqueIndex as myUniqueIndex } from 'drizzle-orm/mysql-core';

/** The three documents an operator can host. Also the public URL segment. */
export const PRIVACY_DOCUMENT_SLUGS = ['privacy', 'terms', 'contact'] as const;
export type PrivacyDocumentSlug = (typeof PRIVACY_DOCUMENT_SLUGS)[number];

// SQLite
export const privacyDocumentsSqlite = sqliteTable('privacy_documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  updatedBy: text('updatedBy'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
}, (t) => ({
  slugUniq: uniqueIndex('privacy_documents_slug_idx').on(t.slug),
}));

// PostgreSQL
export const privacyDocumentsPostgres = pgTable('privacy_documents', {
  id: pgSerial('id').primaryKey(),
  slug: pgText('slug').notNull(),
  title: pgText('title').notNull(),
  content: pgText('content').notNull(),
  updatedBy: pgText('updatedBy'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  slugUniq: pgUniqueIndex('privacy_documents_slug_idx').on(t.slug),
}));

// MySQL
export const privacyDocumentsMysql = mysqlTable('privacy_documents', {
  id: myInt('id').primaryKey().autoincrement(),
  slug: myVarchar('slug', { length: 32 }).notNull(),
  title: myVarchar('title', { length: 255 }).notNull(),
  content: myLongtext('content').notNull(),
  updatedBy: myVarchar('updatedBy', { length: 191 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
}, (t) => ({
  slugUniq: myUniqueIndex('privacy_documents_slug_idx').on(t.slug),
}));

// Inferred types
export type PrivacyDocumentSqlite = typeof privacyDocumentsSqlite.$inferSelect;
export type NewPrivacyDocumentSqlite = typeof privacyDocumentsSqlite.$inferInsert;
export type PrivacyDocumentPostgres = typeof privacyDocumentsPostgres.$inferSelect;
export type PrivacyDocumentMysql = typeof privacyDocumentsMysql.$inferSelect;
