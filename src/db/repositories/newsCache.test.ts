/**
 * Multi-Database News Cache Repository Tests
 *
 * Validates NewsCacheRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { NewsCacheRepository } from './newsCache.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';


const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS user_news_status CASCADE;
  DROP TABLE IF EXISTS news_cache CASCADE;
  CREATE TABLE news_cache (
    id SERIAL PRIMARY KEY,
    "feedData" TEXT NOT NULL,
    "fetchedAt" BIGINT NOT NULL,
    "sourceUrl" TEXT NOT NULL
  );
  CREATE TABLE user_news_status (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "lastSeenNewsId" TEXT,
    "dismissedNewsIds" TEXT,
    "updatedAt" BIGINT NOT NULL
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS user_news_status;
  DROP TABLE IF EXISTS news_cache;
  CREATE TABLE news_cache (
    id SERIAL PRIMARY KEY,
    feedData MEDIUMTEXT NOT NULL,
    fetchedAt BIGINT NOT NULL,
    sourceUrl VARCHAR(512) NOT NULL
  );
  CREATE TABLE user_news_status (
    id SERIAL PRIMARY KEY,
    userId INT NOT NULL,
    lastSeenNewsId VARCHAR(128),
    dismissedNewsIds TEXT,
    updatedAt BIGINT NOT NULL
  )
`;

const ALL_TABLES = ['news_cache', 'user_news_status'];

/**
 * Shared test suite that runs against any backend.
 */
function runNewsCacheTests(getBackend: () => TestBackend) {
  let repo: NewsCacheRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new NewsCacheRepository(backend.drizzleDb, backend.dbType);
    // Seed user 1 for user_news_status FK (real SQLite schema enforces it via migration 041).
    // Try/catch: PG/MySQL test DDL doesn't create the users table, so the insert is a no-op there.
    const now = Date.now();
    try {
      await backend.exec(`INSERT OR IGNORE INTO users (id, username, password_hash, auth_provider, is_admin, is_active, mfa_enabled, created_at, updated_at) VALUES (1, 'testuser', 'hash', 'local', 0, 1, 0, ${now}, ${now})`);
    } catch { /* PG/MySQL — no users table in test DDL */ }
  });

  // ============ NEWS CACHE ============

  it('saveNewsCache and getNewsCache - save and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveNewsCache({
      feedData: JSON.stringify({ items: ['news1', 'news2'] }),
      fetchedAt: now,
      sourceUrl: 'https://example.com/feed',
    });

    const cached = await repo.getNewsCache();
    expect(cached).not.toBeNull();
    expect(cached!.sourceUrl).toBe('https://example.com/feed');
    expect(JSON.parse(cached!.feedData)).toEqual({ items: ['news1', 'news2'] });
  });

  it('getNewsCache - returns null when empty', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getNewsCache();
    expect(result).toBeNull();
  });

  it('saveNewsCache - replaces previous cache', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveNewsCache({ feedData: '{"old": true}', fetchedAt: now, sourceUrl: 'https://old.com/feed' });
    await repo.saveNewsCache({ feedData: '{"new": true}', fetchedAt: now + 1000, sourceUrl: 'https://new.com/feed' });

    const cached = await repo.getNewsCache();
    expect(cached!.sourceUrl).toBe('https://new.com/feed');
    expect(JSON.parse(cached!.feedData)).toEqual({ new: true });
  });

  // ============ USER NEWS STATUS ============

  it('saveUserNewsStatus and getUserNewsStatus - create and retrieve', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-123', dismissedNewsIds: '["news-111"]', updatedAt: now });

    const status = await repo.getUserNewsStatus(1);
    expect(status).not.toBeNull();
    expect(status!.userId).toBe(1);
    expect(status!.lastSeenNewsId).toBe('news-123');
  });

  it('getUserNewsStatus - returns null for missing user', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const result = await repo.getUserNewsStatus(99999);
    expect(result).toBeNull();
  });

  it('saveUserNewsStatus - updates existing record', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const now = Date.now();
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-001', updatedAt: now });
    await repo.saveUserNewsStatus({ userId: 1, lastSeenNewsId: 'news-999', updatedAt: now + 1000 });

    const status = await repo.getUserNewsStatus(1);
    expect(status!.lastSeenNewsId).toBe('news-999');
  });
}

// --- SQLite Backend ---
describe('NewsCacheRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runNewsCacheTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('NewsCacheRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for news cache tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runNewsCacheTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('NewsCacheRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for news cache tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runNewsCacheTests(() => backend);
});
