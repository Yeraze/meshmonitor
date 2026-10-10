/**
 * MapMarkersRepository (#5686, local map markers) on SQLite, PostgreSQL and
 * MySQL, with the table built by migration 199 itself (run twice: the
 * migration must be idempotent).
 *
 * PostgreSQL / MySQL run against the test containers on 5433 / 3307, each in a
 * private database (createIsolated*Database). They skip silently without the
 * containers — confirm via the JSON reporter's numPendingTests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import * as schema from '../schema/index.js';
import { MapMarkersRepository } from './mapMarkers.js';
import {
  migration as migration199,
  runMigration199Postgres,
  runMigration199Mysql,
} from '../../server/migrations/199_create_map_markers.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import type { MapMarkerInput } from '../../types/mapMarker.js';

const SRC_A = 'src-a';
const SRC_B = 'src-b';

const input = (over: Partial<MapMarkerInput> = {}): Required<MapMarkerInput> => ({
  label: 'Ridge site',
  description: 'candidate repeater',
  latitude: 28.123456,
  longitude: -81.654321,
  altitude: 120.5,
  icon: 'antenna',
  color: 'success',
  ...over,
} as Required<MapMarkerInput>);

function runRepoSuite(getRepo: () => MapMarkersRepository, clear: () => Promise<void>) {
  let repo: MapMarkersRepository;
  beforeEach(async () => {
    await clear();
    repo = getRepo();
  });

  it('requires a sourceId', async () => {
    await expect(repo.listBySource('')).rejects.toThrow(/sourceId/);
    await expect(repo.create('', input(), null)).rejects.toThrow(/sourceId/);
  });

  it('creates, reads back exactly, updates and deletes', async () => {
    const created = await repo.create(SRC_A, input(), 7);
    expect(created.id).toBeGreaterThan(0);
    const [row] = await repo.listBySource(SRC_A);
    expect(row).toMatchObject({
      id: created.id, sourceId: SRC_A, label: 'Ridge site', description: 'candidate repeater',
      latitude: 28.123456, longitude: -81.654321, altitude: 120.5, icon: 'antenna', color: 'success',
      createdByUserId: 7,
    });
    expect(row.createdAt).toBe(row.updatedAt);

    const updated = await repo.update(SRC_A, created.id, input({ label: 'Moved', altitude: null, description: null }));
    expect(updated).toMatchObject({ label: 'Moved', altitude: null, description: null });
    expect((await repo.getById(SRC_A, created.id))).toMatchObject({ label: 'Moved', altitude: null, description: null });

    expect(await repo.delete(SRC_A, created.id)).toBe(true);
    expect(await repo.listBySource(SRC_A)).toEqual([]);
    expect(await repo.delete(SRC_A, created.id)).toBe(false);
  });

  it('keeps sources apart: no read, edit or delete across sources', async () => {
    const a = await repo.create(SRC_A, input({ label: 'A' }), null);
    await repo.create(SRC_B, input({ label: 'B' }), null);
    expect((await repo.listBySource(SRC_A)).map((m) => m.label)).toEqual(['A']);
    expect(await repo.getById(SRC_B, a.id)).toBeNull();
    expect(await repo.update(SRC_B, a.id, input({ label: 'hijack' }))).toBeNull();
    expect(await repo.delete(SRC_B, a.id)).toBe(false);
    expect((await repo.getById(SRC_A, a.id))?.label).toBe('A');
  });

  it('counts per source and deletes a whole source', async () => {
    await repo.create(SRC_A, input(), null);
    await repo.create(SRC_A, input(), null);
    await repo.create(SRC_B, input(), null);
    expect(await repo.countBySource(SRC_A)).toBe(2);
    await repo.deleteBySourceId(SRC_A);
    expect(await repo.countBySource(SRC_A)).toBe(0);
    expect(await repo.countBySource(SRC_B)).toBe(1);
  });
}

describe('MapMarkersRepository — SQLite (migration registry)', () => {
  let t: ReturnType<typeof createTestDb>;
  beforeAll(() => { t = createTestDb(); });
  afterAll(() => { t.sqlite.close(); });

  it('migration 199 is idempotent on SQLite', () => {
    expect(() => migration199.up(t.sqlite)).not.toThrow();
    expect(() => migration199.up(t.sqlite)).not.toThrow();
  });

  runRepoSuite(
    () => new MapMarkersRepository(t.db, 'sqlite'),
    async () => { t.sqlite.prepare('DELETE FROM map_markers').run(); },
  );
});

describe('MapMarkersRepository — bare SQLite table from migration 199', () => {
  const sqlite = new Database(':memory:');
  migration199.up(sqlite);
  migration199.up(sqlite);
  const db = drizzleSqlite(sqlite, { schema });
  afterAll(() => sqlite.close());
  runRepoSuite(
    () => new MapMarkersRepository(db, 'sqlite'),
    async () => { sqlite.prepare('DELETE FROM map_markers').run(); },
  );
});

describe.skipIf(!postgresAvailable)('MapMarkersRepository — PostgreSQL (container)', () => {
  let pool: import('pg').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig199'));
    const client = await pool.connect();
    try {
      await runMigration199Postgres(client);
      await runMigration199Postgres(client); // idempotent
    } finally {
      client.release();
    }
    db = drizzlePostgres(pool, { schema });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MapMarkersRepository(db as never, 'postgres'),
    async () => { await pool.query('DELETE FROM map_markers'); },
  );
});

describe.skipIf(!mysqlAvailable)('MapMarkersRepository — MySQL (container)', () => {
  let pool: import('mysql2/promise').Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig199'));
    await runMigration199Mysql(pool);
    await runMigration199Mysql(pool); // idempotent
    db = drizzleMysql(pool, { schema, mode: 'default' });
  });
  afterAll(async () => { await cleanup?.(); });

  runRepoSuite(
    () => new MapMarkersRepository(db as never, 'mysql'),
    async () => { await pool.query('DELETE FROM map_markers'); },
  );
});
