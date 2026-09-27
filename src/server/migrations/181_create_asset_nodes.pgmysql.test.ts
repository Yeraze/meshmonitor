/**
 * Migration 181 + AssetNodesRepository — PostgreSQL / MySQL container behaviour (#5354).
 *
 * The SQLite repository suite builds its fixture from the migration registry,
 * so it cannot catch a PostgreSQL/MySQL `CREATE TABLE` that disagrees with the
 * Drizzle schema. The quiet failures that matter:
 *
 *  - `nodeNum` declared INTEGER instead of BIGINT overflows for any node number
 *    above 0x7fffffff;
 *  - an unquoted `"retentionDays"` in PostgreSQL folds to `retentiondays`, and
 *    the Drizzle select comes back undefined rather than erroring.
 *
 * So: run the real migration against an isolated empty database, then write
 * and read through the real repository.
 *
 * **Isolation.** Own database per backend via createIsolated*Database (CLAUDE.md
 * Multi-Database). A silent skip still reports `success: true`; confirm
 * coverage via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../../db/schema/index.js';
import { runMigration181Postgres, runMigration181Mysql } from './181_create_asset_nodes.js';
import { AssetNodesRepository } from '../../db/repositories/assetNodes.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

/** Above the signed 32-bit ceiling — the case an INTEGER column breaks. */
const BIG_NODE = 0xfedcba98;

function repoBehaviour(getRepo: () => AssetNodesRepository) {
  it('round-trips an asset above the signed 32-bit range', async () => {
    const repo = getRepo();
    await repo.setAsync(BIG_NODE, 120, 4);
    const row = await repo.getAsync(BIG_NODE);
    expect(row).toMatchObject({ nodeNum: BIG_NODE, retentionDays: 120, updatedBy: 4 });
    expect(typeof row!.updatedAt).toBe('number');
    expect((await repo.getMapAsync()).get(BIG_NODE)).toEqual({ retentionDays: 120 });
  });

  it('upserts instead of duplicating, and clears', async () => {
    const repo = getRepo();
    await repo.setAsync(BIG_NODE, 5, null);
    const all = await repo.getAllAsync();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ retentionDays: 5, updatedBy: null });
    await repo.clearAsync(BIG_NODE);
    expect(await repo.getAllAsync()).toEqual([]);
  });
}

describe.skipIf(!postgresAvailable)('migration 181 — PostgreSQL (container)', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresDatabase>>;
  let repo: AssetNodesRepository;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresDatabase('mig181');
    const client = await isolated.pool.connect();
    try {
      await runMigration181Postgres(client);
      // Idempotent: a second run is a no-op.
      await runMigration181Postgres(client);
    } finally {
      client.release();
    }
    repo = new AssetNodesRepository(drizzlePostgres(isolated.pool, { schema }) as never, 'postgres');
  }, 30_000);

  afterAll(async () => {
    if (isolated) await isolated.cleanup();
  });

  repoBehaviour(() => repo);
});

describe.skipIf(!mysqlAvailable)('migration 181 — MySQL (container)', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedMysqlDatabase>>;
  let repo: AssetNodesRepository;

  beforeAll(async () => {
    isolated = await createIsolatedMysqlDatabase('mig181');
    await runMigration181Mysql(isolated.pool);
    await runMigration181Mysql(isolated.pool);
    repo = new AssetNodesRepository(drizzleMysql(isolated.pool, { schema, mode: 'default' }) as never, 'mysql');
  }, 30_000);

  afterAll(async () => {
    if (isolated) await isolated.cleanup();
  });

  repoBehaviour(() => repo);
});
