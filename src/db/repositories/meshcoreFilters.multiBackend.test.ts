/**
 * MeshCoreFiltersRepository on PostgreSQL and MySQL (#5408). Tables come from
 * the real migration-182 runners; each backend uses its own isolated database.
 * Skips silently when the containers are down — confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { MeshCoreFiltersRepository } from './meshcoreFilters.js';
import { runMigration182Postgres, runMigration182Mysql } from '../../server/migrations/182_create_meshcore_ignore_block.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const KEY = 'cd'.repeat(32);

function runSharedTests(getRepo: () => MeshCoreFiltersRepository) {
  it('ignored nodes round-trip with ms timestamps, upsert keeps hits, scoped per source', async () => {
    const repo = getRepo();
    const first = await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'X', mode: 'ignore', createdBy: 3 });
    expect(first.createdAt).toBeGreaterThan(1_700_000_000_000);
    await repo.addIgnoredNodeHits('src-a', KEY, 2, 1_790_000_000_123);
    const second = await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'Y', mode: 'block', createdBy: 3 });
    expect(second).toMatchObject({ name: 'Y', mode: 'block', hitCount: 2, lastHitAt: 1_790_000_000_123, createdAt: first.createdAt });
    expect(await repo.listIgnoredNodes('src-b')).toEqual([]);
    expect(await repo.removeIgnoredNode('src-a', KEY)).toBe(1);
    expect(await repo.listIgnoredNodes('src-a')).toEqual([]);
  });

  it('message filters round-trip booleans and scope by source', async () => {
    const repo = getRepo();
    const rule = await repo.createMessageFilter('src-a', {
      mode: 'block', matchType: 'regex', pattern: '^buy', caseSensitive: true, fields: 'name', enabled: true,
    }, null);
    expect(rule).toMatchObject({ mode: 'block', matchType: 'regex', caseSensitive: true, fields: 'name', enabled: true });
    const updated = await repo.updateMessageFilter('src-a', rule.id, { enabled: false, caseSensitive: false });
    expect(updated).toMatchObject({ enabled: false, caseSensitive: false });
    expect(await repo.updateMessageFilter('src-b', rule.id, { enabled: true })).toBeNull();
    await repo.addMessageFilterHits('src-a', rule.id, 5, 42);
    expect(await repo.getMessageFilter('src-a', rule.id)).toMatchObject({ hitCount: 5, lastHitAt: 42 });
    expect(await repo.deleteMessageFilter('src-b', rule.id)).toBe(0);
    expect(await repo.deleteMessageFilter('src-a', rule.id)).toBe(1);
  });
}

describe.skipIf(!postgresAvailable)('MeshCoreFiltersRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreFiltersRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('mcfilters'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b') ON CONFLICT DO NOTHING`);
    const client = await pool.connect();
    try {
      await runMigration182Postgres(client);
    } finally {
      client.release();
    }
    repo = new MeshCoreFiltersRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_ignored_nodes');
    await pool.query('DELETE FROM meshcore_message_filters');
  });

  runSharedTests(() => repo);
});

describe.skipIf(!mysqlAvailable)('MeshCoreFiltersRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: MeshCoreFiltersRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('mcfilters'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a'), ('src-b')`);
    await runMigration182Mysql(pool);
    repo = new MeshCoreFiltersRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_ignored_nodes');
    await pool.query('DELETE FROM meshcore_message_filters');
  });

  runSharedTests(() => repo);
});
