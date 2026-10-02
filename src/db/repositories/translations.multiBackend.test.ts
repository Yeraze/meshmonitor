/**
 * TranslationsRepository — identical behaviour on SQLite, PostgreSQL and
 * MySQL (#5520).
 *
 * Tables come from the REAL migration-186 runners (run twice, to prove
 * idempotency), not hand-written DDL. Only a minimal `messages` table
 * (`id`, `sourceId`) is hand-rolled: the orphan sweep only correlates on
 * those two columns. Each PG/MySQL suite owns an isolated database
 * (`createIsolated*Database('trcache')`) so it cannot race other suites.
 *
 * The PG/MySQL halves `skipIf` without the test containers — confirm via
 * `numPendingTests` in the JSON reporter, not `success` alone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { TranslationsRepository } from './translations.js';
import { ALL_SOURCES } from './base.js';
import {
  migration as migration186,
  runMigration186Postgres,
  runMigration186Mysql,
} from '../../server/migrations/186_create_translation_cache.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;
const TTL = 30 * DAY;

interface Ctx {
  repo: TranslationsRepository;
  addMessage(id: string, sourceId: string): Promise<void>;
  removeMessage(id: string): Promise<void>;
  /** Corrupt a counter directly, to test reconciliation. */
  setRefCount(cacheKey: string, n: number): Promise<void>;
}

function entry(cacheKey: string, text = `t-${cacheKey}`) {
  return { cacheKey, targetLang: 'en', translatedText: text, detectedSourceLanguage: 'ja', provider: 'deepl' };
}

function runSharedTests(getCtx: () => Ctx) {
  it('insert / get / touch round-trip, with ms timestamps as numbers', async () => {
    const { repo } = getCtx();
    expect(await repo.insertCacheEntry(entry('k1', 'Hello'), NOW)).toBe(true);
    // A second insert of the same key is ignored, not an error.
    expect(await repo.insertCacheEntry(entry('k1', 'Other'), NOW + 1)).toBe(false);

    await repo.touchCacheEntry('k1', NOW + 5000);
    const row = await repo.getCacheEntry('k1');
    expect(row).toMatchObject({
      cacheKey: 'k1', translatedText: 'Hello', hitCount: 1, messageRefCount: 0,
      createdAt: NOW, lastUsedAt: NOW + 5000, detectedSourceLanguage: 'ja', sourceLang: null,
    });
    expect(await repo.getCacheEntry('missing')).toBeNull();
  });

  it('linkMessage maintains messageRefCount across add, re-link, move and orphan sweep', async () => {
    const { repo, addMessage, removeMessage } = getCtx();
    await repo.insertCacheEntry(entry('ka'), NOW);
    await repo.insertCacheEntry(entry('kb'), NOW);
    await addMessage('m1', 'src-a');
    await addMessage('m2', 'src-a');

    expect(await repo.linkMessage('src-a', 'm1', 'en', 'ka', NOW)).toBe(true);
    expect(await repo.linkMessage('src-a', 'm1', 'en', 'ka', NOW)).toBe(true); // no double count
    expect(await repo.linkMessage('src-a', 'm2', 'en', 'ka', NOW)).toBe(true);
    expect((await repo.getCacheEntry('ka'))?.messageRefCount).toBe(2);

    // Moving m2's link to another entry moves the reference.
    await repo.linkMessage('src-a', 'm2', 'en', 'kb', NOW);
    expect((await repo.getCacheEntry('ka'))?.messageRefCount).toBe(1);
    expect((await repo.getCacheEntry('kb'))?.messageRefCount).toBe(1);

    // Unknown cache entry: nothing written.
    expect(await repo.linkMessage('src-a', 'm1', 'es', 'nope', NOW)).toBe(false);

    await removeMessage('m1');
    expect(await repo.removeOrphanedLinks('src-a')).toBe(1);
    expect((await repo.getCacheEntry('ka'))?.messageRefCount).toBe(0);
    expect((await repo.getCacheEntry('kb'))?.messageRefCount).toBe(1);
  });

  it('getStoredTranslations is scoped by source and language', async () => {
    const { repo, addMessage } = getCtx();
    await repo.insertCacheEntry(entry('kx', 'Good morning'), NOW);
    await addMessage('m1', 'src-a');
    await addMessage('m9', 'src-b');
    await repo.linkMessage('src-a', 'm1', 'en', 'kx', NOW);
    await repo.linkMessage('src-b', 'm9', 'en', 'kx', NOW);

    const a = await repo.getStoredTranslations('src-a', ['m1', 'm9'], 'en');
    expect(a).toEqual([{ messageId: 'm1', targetLang: 'en', translatedText: 'Good morning', detectedSourceLanguage: 'ja', provider: 'deepl' }]);
    expect(await repo.getStoredTranslations('src-a', ['m1'], 'es')).toEqual([]);
    expect(await repo.getStoredTranslations('src-b', ['m1'], 'en')).toEqual([]);
  });

  it('prune: TTL drops unreferenced stale rows, keeps referenced and pinned ones', async () => {
    const { repo, addMessage } = getCtx();
    await repo.insertCacheEntry(entry('stale'), NOW - 31 * DAY);
    await repo.insertCacheEntry(entry('fresh'), NOW - 29 * DAY);
    await repo.insertCacheEntry(entry('referenced'), NOW - 90 * DAY);
    await repo.insertCacheEntry(entry('pinned'), NOW - 90 * DAY);
    await addMessage('m1', 'src-a');
    await addMessage('m2', 'src-a');
    await addMessage('m3', 'src-b');
    await repo.linkMessage('src-a', 'm1', 'en', 'referenced', NOW - 90 * DAY);
    await repo.linkMessage('src-a', 'm2', 'en', 'pinned', NOW - 90 * DAY);
    await repo.linkMessage('src-b', 'm3', 'en', 'pinned', NOW - 90 * DAY);

    const result = await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 10_000 });
    expect(result).toEqual({ orphanedLinksRemoved: 0, expired: 1, evicted: 0 });
    expect(await repo.getCacheEntry('stale')).toBeNull();
    expect(await repo.getCacheEntry('fresh')).not.toBeNull();
    expect(await repo.getCacheEntry('referenced')).not.toBeNull();
    expect((await repo.getCacheEntry('pinned'))?.messageRefCount).toBe(2);
  });

  it('prune: the size cap evicts least-recently-used unreferenced rows only', async () => {
    const { repo, addMessage } = getCtx();
    for (let i = 0; i < 5; i++) {
      await repo.insertCacheEntry(entry(`lru${i}`), NOW - (10 - i) * DAY); // lru0 oldest
    }
    await repo.insertCacheEntry(entry('ref-old'), NOW - 20 * DAY);
    await repo.insertCacheEntry(entry('pin-old'), NOW - 20 * DAY);
    await addMessage('m1', 'src-a');
    await addMessage('m2', 'src-a');
    await addMessage('m3', 'src-a');
    await repo.linkMessage('src-a', 'm1', 'en', 'ref-old', NOW);
    await repo.linkMessage('src-a', 'm2', 'en', 'pin-old', NOW);
    await repo.linkMessage('src-a', 'm3', 'en', 'pin-old', NOW);

    // The cap counts only unpinned, unreferenced rows: 5; cap 3 → evict the 2 LRU.
    const result = await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 3 });
    expect(result.evicted).toBe(2);
    expect(await repo.getCacheEntry('lru0')).toBeNull();
    expect(await repo.getCacheEntry('lru1')).toBeNull();
    expect(await repo.getCacheEntry('lru2')).not.toBeNull();
    expect(await repo.getCacheEntry('ref-old')).not.toBeNull();
    expect(await repo.getCacheEntry('pin-old')).not.toBeNull();
  });

  it('prune sweeps links whose message vanished, then lets the entry expire', async () => {
    const { repo, addMessage, removeMessage } = getCtx();
    await repo.insertCacheEntry(entry('gone'), NOW - 40 * DAY);
    await addMessage('m1', 'src-a');
    await repo.linkMessage('src-a', 'm1', 'en', 'gone', NOW - 40 * DAY);
    await removeMessage('m1'); // e.g. an FK cascade that bypassed the repository

    const result = await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 10_000 });
    expect(result.orphanedLinksRemoved).toBe(1);
    expect(result.expired).toBe(1);
    expect(await repo.getCacheEntry('gone')).toBeNull();
  });

  it('reconcileMessageRefCounts repairs a drifted counter', async () => {
    const { repo, addMessage, setRefCount } = getCtx();
    await repo.insertCacheEntry(entry('drift'), NOW);
    await addMessage('m1', 'src-a');
    await repo.linkMessage('src-a', 'm1', 'en', 'drift', NOW);
    await setRefCount('drift', 7);
    // Nothing orphaned → the sweep alone does not recount.
    expect(await repo.removeOrphanedLinks(ALL_SOURCES)).toBe(0);
    await repo.reconcileMessageRefCounts();
    expect(await repo.getCacheEntry('drift')).toMatchObject({ messageRefCount: 1, pinnedAt: null });
  });

  it('pins an entry at its 2nd distinct message, and the pin is sticky', async () => {
    const { repo, addMessage, removeMessage } = getCtx();
    await repo.insertCacheEntry(entry('hi'), NOW - 90 * DAY);
    await addMessage('m1', 'src-a');
    await addMessage('m2', 'src-b');

    await repo.linkMessage('src-a', 'm1', 'en', 'hi', NOW - 90 * DAY);
    // Re-linking the same message is not a second distinct message.
    await repo.linkMessage('src-a', 'm1', 'en', 'hi', NOW - 90 * DAY);
    expect((await repo.getCacheEntry('hi'))?.pinnedAt).toBeNull();

    await repo.linkMessage('src-b', 'm2', 'en', 'hi', NOW - 89 * DAY);
    expect((await repo.getCacheEntry('hi'))?.pinnedAt).toBe(NOW - 89 * DAY);

    // Both messages purged: the sweep and recount drop the count to 0 but never unpin.
    await removeMessage('m1');
    await removeMessage('m2');
    expect(await repo.removeOrphanedLinks(ALL_SOURCES)).toBe(2);
    await repo.reconcileMessageRefCounts(NOW);
    expect(await repo.getCacheEntry('hi')).toMatchObject({ messageRefCount: 0, pinnedAt: NOW - 89 * DAY });

    // Unused for 90 days, under maximum cap pressure: still kept.
    await repo.insertCacheEntry(entry('filler'), NOW - 100 * DAY);
    const result = await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 0 });
    expect(result.expired).toBe(1); // only 'filler'
    expect(await repo.getCacheEntry('hi')).not.toBeNull();
    expect(await repo.getCacheEntry('filler')).toBeNull();
  });

  it('a single-reference entry is not pinned and ages out once its message is gone', async () => {
    const { repo, addMessage, removeMessage } = getCtx();
    await repo.insertCacheEntry(entry('once'), NOW - 40 * DAY);
    await addMessage('m1', 'src-a');
    await repo.linkMessage('src-a', 'm1', 'en', 'once', NOW - 40 * DAY);

    // Referenced: survives TTL and cap.
    expect((await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 0 })).expired).toBe(0);
    expect(await repo.getCacheEntry('once')).toMatchObject({ messageRefCount: 1, pinnedAt: null });

    await removeMessage('m1');
    const result = await repo.pruneCache({ now: NOW, ttlMs: TTL, maxUnpinned: 10_000 });
    expect(result.expired).toBe(1);
    expect(await repo.getCacheEntry('once')).toBeNull();
  });

  it('reconcile pins an entry whose links reached the threshold outside linkMessage', async () => {
    const { repo, addMessage, setRefCount } = getCtx();
    await repo.insertCacheEntry(entry('late'), NOW);
    await addMessage('m1', 'src-a');
    await addMessage('m2', 'src-a');
    await repo.linkMessage('src-a', 'm1', 'en', 'late', NOW);
    await repo.linkMessage('src-a', 'm2', 'en', 'late', NOW);
    // Simulate a pre-pin row: count right, pin missing.
    await setRefCount('late', 0);
    await repo.reconcileMessageRefCounts(NOW + 1);
    expect(await repo.getCacheEntry('late')).toMatchObject({ messageRefCount: 2 });
    expect((await repo.getCacheEntry('late'))?.pinnedAt).not.toBeNull();
  });
}

describe('TranslationsRepository — SQLite', () => {
  let sqlite: Database.Database;
  let ctx: Ctx;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    migration186.up(sqlite);
    migration186.up(sqlite);
    sqlite.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, sourceId TEXT)');
    const repo = new TranslationsRepository(drizzleSqlite(sqlite, { schema }), 'sqlite');
    ctx = {
      repo,
      addMessage: async (id, sourceId) => { sqlite.prepare('INSERT INTO messages (id, sourceId) VALUES (?, ?)').run(id, sourceId); },
      removeMessage: async (id) => { sqlite.prepare('DELETE FROM messages WHERE id = ?').run(id); },
      setRefCount: async (k, n) => { sqlite.prepare('UPDATE translation_cache SET messageRefCount = ? WHERE cacheKey = ?').run(n, k); },
    };
  });

  runSharedTests(() => ctx);

  it('removeOrphanedLinksSqliteSync matches the async sweep', async () => {
    await ctx.repo.insertCacheEntry(entry('ks'), NOW);
    await ctx.addMessage('m1', 'src-a');
    await ctx.repo.linkMessage('src-a', 'm1', 'en', 'ks', NOW);
    await ctx.removeMessage('m1');
    expect(ctx.repo.removeOrphanedLinksSqliteSync('src-a')).toBe(1);
    expect((await ctx.repo.getCacheEntry('ks'))?.messageRefCount).toBe(0);
  });

  it('removeOrphanedLinks refuses a missing scope', async () => {
    await expect(ctx.repo.removeOrphanedLinks('' as string)).rejects.toThrow(/sourceId or ALL_SOURCES/);
  });
});

describe.skipIf(!postgresAvailable)('TranslationsRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let ctx: Ctx;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('trcache');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration186Postgres(client);
      await runMigration186Postgres(client);
    } finally {
      client.release();
    }
    await pool.query('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, "sourceId" TEXT)');
    const repo = new TranslationsRepository(drizzlePostgres(pool, { schema }), 'postgres');
    ctx = {
      repo,
      addMessage: async (id, sourceId) => { await pool.query('INSERT INTO messages (id, "sourceId") VALUES ($1, $2)', [id, sourceId]); },
      removeMessage: async (id) => { await pool.query('DELETE FROM messages WHERE id = $1', [id]); },
      setRefCount: async (k, n) => { await pool.query('UPDATE translation_cache SET "messageRefCount" = $1 WHERE "cacheKey" = $2', [n, k]); },
    };
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE translation_cache, message_translations, messages');
  });

  runSharedTests(() => ctx);
});

describe.skipIf(!mysqlAvailable)('TranslationsRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let ctx: Ctx;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('trcache');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration186Mysql(pool);
    await runMigration186Mysql(pool);
    await pool.query('CREATE TABLE IF NOT EXISTS messages (id VARCHAR(64) PRIMARY KEY, sourceId VARCHAR(36))');
    const repo = new TranslationsRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
    ctx = {
      repo,
      addMessage: async (id, sourceId) => { await pool.query('INSERT INTO messages (id, sourceId) VALUES (?, ?)', [id, sourceId]); },
      removeMessage: async (id) => { await pool.query('DELETE FROM messages WHERE id = ?', [id]); },
      setRefCount: async (k, n) => { await pool.query('UPDATE translation_cache SET messageRefCount = ? WHERE cacheKey = ?', [n, k]); },
    };
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE translation_cache');
    await pool.query('TRUNCATE TABLE message_translations');
    await pool.query('TRUNCATE TABLE messages');
  });

  runSharedTests(() => ctx);
});
