/**
 * Drizzle schema for the translation cache (#5520, follow-up to #5480).
 *
 * Two tables:
 *
 * `translation_cache` — the shared, server-internal text cache. GLOBAL by
 * design (no `sourceId`): one row per (normalized text, target language,
 * optional source language). The primary key `cacheKey` is a sha256 of that
 * tuple. **The source text is never stored**, only its hash, so a database
 * reader cannot recover message text from this table, and no route accepts
 * text to look up here (see TRANSLATION_CACHE_SPEC.md "Rules").
 *
 * `message_translations` — per-source link from a Meshtastic `messages` row
 * to a cache entry, keyed `(sourceId, messageId, targetLang)`. A phrase reused
 * by many messages is translated and stored once. Links live as long as their
 * message: every message delete path sweeps orphaned links
 * (`TranslationsRepository.removeOrphanedLinks`), and the hourly prune job
 * sweeps again for any path that bypasses the repository (FK cascades, node
 * identity merges, restores).
 *
 * `messageRefCount` = number of link rows that point at a cache entry, i.e.
 * the number of distinct messages that reference it (a message links to a
 * given cacheKey at most once because the key includes the target language).
 * Entries with `messageRefCount >= 1` are never pruned. The first time an
 * entry reaches `messageRefCount >= 2`, `pinnedAt` is set and never cleared:
 * a reused phrase ("Hi", "Good morning") never expires, even after the
 * messages that referenced it are purged.
 *
 * Indexes are declared in migration 188, not here (project convention, see
 * `coverageSurveys.ts`).
 */
import { sqliteTable, text, integer, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, primaryKey as pgPrimaryKey } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint, primaryKey as myPrimaryKey } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const translationCacheSqlite = sqliteTable('translation_cache', {
  // sha256 hex of the (normalized text, targetLang, sourceLang) tuple.
  cacheKey: text('cacheKey').primaryKey(),
  targetLang: text('targetLang').notNull(),
  // null = auto-detect.
  sourceLang: text('sourceLang'),
  translatedText: text('translatedText').notNull(),
  detectedSourceLanguage: text('detectedSourceLanguage'),
  provider: text('provider').notNull(),
  // Unix ms.
  createdAt: integer('createdAt').notNull(),
  // Unix ms; refreshed on every cache hit. Drives the 30-day TTL + LRU cap.
  lastUsedAt: integer('lastUsedAt').notNull(),
  hitCount: integer('hitCount').notNull().default(0),
  messageRefCount: integer('messageRefCount').notNull().default(0),
  // Unix ms when the entry was first referenced by a 2nd distinct message.
  // STICKY: once set, never cleared — the entry never expires (#5520).
  pinnedAt: integer('pinnedAt'),
});

export const messageTranslationsSqlite = sqliteTable('message_translations', {
  sourceId: text('sourceId').notNull(),
  messageId: text('messageId').notNull(),
  targetLang: text('targetLang').notNull(),
  cacheKey: text('cacheKey').notNull(),
  createdAt: integer('createdAt').notNull(),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.messageId, table.targetLang] }),
}));

// ============ PostgreSQL Schema ============

export const translationCachePostgres = pgTable('translation_cache', {
  cacheKey: pgText('cacheKey').primaryKey(),
  targetLang: pgText('targetLang').notNull(),
  sourceLang: pgText('sourceLang'),
  translatedText: pgText('translatedText').notNull(),
  detectedSourceLanguage: pgText('detectedSourceLanguage'),
  provider: pgText('provider').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  lastUsedAt: pgBigint('lastUsedAt', { mode: 'number' }).notNull(),
  hitCount: pgInteger('hitCount').notNull().default(0),
  messageRefCount: pgInteger('messageRefCount').notNull().default(0),
  pinnedAt: pgBigint('pinnedAt', { mode: 'number' }),
});

export const messageTranslationsPostgres = pgTable('message_translations', {
  sourceId: pgText('sourceId').notNull(),
  messageId: pgText('messageId').notNull(),
  targetLang: pgText('targetLang').notNull(),
  cacheKey: pgText('cacheKey').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.messageId, table.targetLang] }),
}));

// ============ MySQL Schema ============

export const translationCacheMysql = mysqlTable('translation_cache', {
  cacheKey: myVarchar('cacheKey', { length: 64 }).primaryKey(),
  targetLang: myVarchar('targetLang', { length: 16 }).notNull(),
  sourceLang: myVarchar('sourceLang', { length: 16 }),
  translatedText: myText('translatedText').notNull(),
  detectedSourceLanguage: myVarchar('detectedSourceLanguage', { length: 16 }),
  provider: myVarchar('provider', { length: 32 }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  lastUsedAt: myBigint('lastUsedAt', { mode: 'number' }).notNull(),
  hitCount: myInt('hitCount').notNull().default(0),
  messageRefCount: myInt('messageRefCount').notNull().default(0),
  pinnedAt: myBigint('pinnedAt', { mode: 'number' }),
});

export const messageTranslationsMysql = mysqlTable('message_translations', {
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  // Matches messages.id (VARCHAR(64)).
  messageId: myVarchar('messageId', { length: 64 }).notNull(),
  targetLang: myVarchar('targetLang', { length: 16 }).notNull(),
  cacheKey: myVarchar('cacheKey', { length: 64 }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.messageId, table.targetLang] }),
}));

// ============ Type Inference ============

export type TranslationCacheRowSqlite = typeof translationCacheSqlite.$inferSelect;
export type MessageTranslationRowSqlite = typeof messageTranslationsSqlite.$inferSelect;
