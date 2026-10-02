/**
 * Migration 188: create `translation_cache` and `message_translations`
 * (#5520, translation cache follow-up to #5480).
 *
 * `translation_cache` is GLOBAL (no `sourceId`): one row per hashed
 * (normalized text, target language, optional source language). The source
 * text itself is never stored — only its sha256 in `cacheKey`.
 *
 * `message_translations` is PER-SOURCE: links a Meshtastic `messages` row to a
 * cache entry, PK `(sourceId, messageId, targetLang)`. No FK to `messages`:
 * SQLite would need the composite (id, sourceId) parent key, and the MySQL
 * column types would have to match `messages` exactly. Instead every message
 * delete path sweeps orphaned links and the hourly prune job reconciles
 * `messageRefCount` — see `src/db/repositories/translations.ts`.
 *
 * `pinnedAt` (ms, nullable) is set the first time an entry is referenced by a
 * second distinct message and is never cleared: pinned entries never expire.
 *
 * Indexes:
 *  - `trc_prune_idx (messageRefCount, lastUsedAt)` — TTL + LRU prune scans.
 *  - `msgtr_cache_key_idx (cacheKey)` — refcount reconciliation.
 *
 * No backfill; both tables start empty. Idempotent on all three backends.
 * See docs/internal/dev-notes/TRANSLATION_CACHE_SPEC.md.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 188';
const CACHE_TABLE = 'translation_cache';
const LINK_TABLE = 'message_translations';
const PRUNE_INDEX = 'trc_prune_idx';
const CACHE_KEY_INDEX = 'msgtr_cache_key_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${CACHE_TABLE} + ${LINK_TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
        cacheKey TEXT PRIMARY KEY,
        targetLang TEXT NOT NULL,
        sourceLang TEXT,
        translatedText TEXT NOT NULL,
        detectedSourceLanguage TEXT,
        provider TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        lastUsedAt INTEGER NOT NULL,
        hitCount INTEGER NOT NULL DEFAULT 0,
        messageRefCount INTEGER NOT NULL DEFAULT 0,
        pinnedAt INTEGER
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${PRUNE_INDEX} ON ${CACHE_TABLE}(messageRefCount, lastUsedAt)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${LINK_TABLE} (
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        targetLang TEXT NOT NULL,
        cacheKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (sourceId, messageId, targetLang)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${CACHE_KEY_INDEX} ON ${LINK_TABLE}(cacheKey)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${LINK_TABLE} + ${CACHE_TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${LINK_TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${CACHE_TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration188Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${CACHE_TABLE} + ${LINK_TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${CACHE_TABLE} (
      "cacheKey" TEXT PRIMARY KEY,
      "targetLang" TEXT NOT NULL,
      "sourceLang" TEXT,
      "translatedText" TEXT NOT NULL,
      "detectedSourceLanguage" TEXT,
      provider TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "lastUsedAt" BIGINT NOT NULL,
      "hitCount" INTEGER NOT NULL DEFAULT 0,
      "messageRefCount" INTEGER NOT NULL DEFAULT 0,
      "pinnedAt" BIGINT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${PRUNE_INDEX} ON ${CACHE_TABLE}("messageRefCount", "lastUsedAt")`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${LINK_TABLE} (
      "sourceId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "targetLang" TEXT NOT NULL,
      "cacheKey" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      PRIMARY KEY ("sourceId", "messageId", "targetLang")
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${CACHE_KEY_INDEX} ON ${LINK_TABLE}("cacheKey")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration188Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${CACHE_TABLE} + ${LINK_TABLE}...`);

  await createTableIfMissingMysql(pool, CACHE_TABLE, `
    CREATE TABLE ${CACHE_TABLE} (
      cacheKey VARCHAR(64) PRIMARY KEY,
      targetLang VARCHAR(16) NOT NULL,
      sourceLang VARCHAR(16),
      translatedText TEXT NOT NULL,
      detectedSourceLanguage VARCHAR(16),
      provider VARCHAR(32) NOT NULL,
      createdAt BIGINT NOT NULL,
      lastUsedAt BIGINT NOT NULL,
      hitCount INT NOT NULL DEFAULT 0,
      messageRefCount INT NOT NULL DEFAULT 0,
      pinnedAt BIGINT,
      INDEX ${PRUNE_INDEX} (messageRefCount, lastUsedAt)
    )
  `);

  await createTableIfMissingMysql(pool, LINK_TABLE, `
    CREATE TABLE ${LINK_TABLE} (
      sourceId VARCHAR(36) NOT NULL,
      messageId VARCHAR(64) NOT NULL,
      targetLang VARCHAR(16) NOT NULL,
      cacheKey VARCHAR(64) NOT NULL,
      createdAt BIGINT NOT NULL,
      PRIMARY KEY (sourceId, messageId, targetLang),
      INDEX ${CACHE_KEY_INDEX} (cacheKey)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
