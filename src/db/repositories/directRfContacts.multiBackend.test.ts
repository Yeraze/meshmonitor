/**
 * DirectRfContactsRepository (#6210) on SQLite, PostgreSQL and MySQL.
 *
 * The PG/MySQL tables are built by the real migration-233 runners, each in
 * its OWN isolated database (`directrf`) so this suite can run next to any
 * other container suite (CLAUDE.md "PG/MySQL fixture races").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import type Database from 'better-sqlite3';
import * as schema from '../schema/index.js';
import {
  DirectRfContactsRepository,
  directRfDayBucket,
  DIRECT_RF_DAY_MS,
  type DirectRfContactDelta,
} from './directRfContacts.js';
import { runMigration233Postgres, runMigration233Mysql } from '../../server/migrations/233_create_direct_rf_contacts.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const DAY = DIRECT_RF_DAY_MS;
const D0 = directRfDayBucket(1_760_000_000_000);
const T0 = D0 + 3_600_000; // 01:00 UTC on day D0

function delta(o: Partial<DirectRfContactDelta> = {}): DirectRfContactDelta {
  return {
    sourceId: 'src-a', protocol: 'meshtastic', nodeKey: '!aaaaaaaa', nodeNum: 0xaaaaaaaa,
    dayBucket: D0, firstHeardAt: T0, lastHeardAt: T0, count: 1,
    bestSnr: 5, bestRssi: -90, snrSum: 5, snrCount: 1, rssiSum: -90, rssiCount: 1,
    ...o,
  };
}

function runSharedTests(getRepo: () => DirectRfContactsRepository) {
  it('merges deltas for one day into one row: count, first/last, best, sums', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({
      firstHeardAt: T0 + 60_000, lastHeardAt: T0 + 120_000, count: 2,
      bestSnr: 9, bestRssi: -95, snrSum: 12, snrCount: 2, rssiSum: -190, rssiCount: 2,
    }));
    await repo.applyDelta(delta({ firstHeardAt: T0 - 60_000, lastHeardAt: T0 - 60_000, bestSnr: null, bestRssi: null, snrSum: 0, snrCount: 0, rssiSum: 0, rssiCount: 0 }));

    const rows = await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + DAY - 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeKey: '!aaaaaaaa', nodeNum: 0xaaaaaaaa, protocol: 'meshtastic',
      firstHeardAt: T0 - 60_000, lastHeardAt: T0 + 120_000, receptionCount: 4,
      bestSnr: 9, bestRssi: -90, daysHeard: 1,
    });
    expect(rows[0].avgSnr).toBeCloseTo(17 / 3, 5);
    expect(rows[0].avgRssi).toBeCloseTo(-280 / 3, 5);
    expect(typeof rows[0].nodeNum).toBe('number');
  });

  it('folds several days per node and orders most recently heard first', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({ dayBucket: D0 + DAY, firstHeardAt: T0 + DAY, lastHeardAt: T0 + DAY, count: 3, bestSnr: 2, snrSum: 6, snrCount: 3 }));
    await repo.applyDelta(delta({ nodeKey: '!bbbbbbbb', nodeNum: 0xbbbbbbbb, dayBucket: D0 + 2 * DAY, firstHeardAt: T0 + 2 * DAY, lastHeardAt: T0 + 2 * DAY }));

    const rows = await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + 3 * DAY });
    expect(rows.map((r) => r.nodeKey)).toEqual(['!bbbbbbbb', '!aaaaaaaa']);
    expect(rows[1]).toMatchObject({ receptionCount: 4, daysHeard: 2, bestSnr: 5, firstHeardAt: T0, lastHeardAt: T0 + DAY });
  });

  it('a window returns only the days it overlaps', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({ dayBucket: D0 + 5 * DAY, firstHeardAt: T0 + 5 * DAY, lastHeardAt: T0 + 5 * DAY }));
    const rows = await repo.getContacts({ sourceId: 'src-a', fromMs: D0 + 4 * DAY, toMs: D0 + 6 * DAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ receptionCount: 1, firstHeardAt: T0 + 5 * DAY });
    // A window that ends before the day's first reception excludes that row.
    expect(await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: T0 - 1 })).toHaveLength(0);
  });

  it('getNodeDaily returns one node\'s days oldest first; nodeKey narrows getContacts', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta({ dayBucket: D0 + DAY, firstHeardAt: T0 + DAY, lastHeardAt: T0 + DAY, count: 2 }));
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({ nodeKey: '!bbbbbbbb', nodeNum: 0xbbbbbbbb }));
    const daily = await repo.getNodeDaily({ sourceId: 'src-a', nodeKey: '!aaaaaaaa', fromMs: D0, toMs: D0 + 2 * DAY });
    expect(daily.map((d) => [d.dayBucket, d.receptionCount])).toEqual([[D0, 1], [D0 + DAY, 2]]);
    const one = await repo.getContacts({ sourceId: 'src-a', nodeKey: '!bbbbbbbb', fromMs: D0, toMs: D0 + 2 * DAY });
    expect(one.map((r) => r.nodeKey)).toEqual(['!bbbbbbbb']);
  });

  it('keeps MeshCore rows keyed by public key with a null nodeNum', async () => {
    const repo = getRepo();
    const key = 'ab'.repeat(32);
    await repo.applyDelta(delta({ protocol: 'meshcore', nodeKey: key, nodeNum: null }));
    const [row] = await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + DAY });
    expect(row).toMatchObject({ protocol: 'meshcore', nodeKey: key, nodeNum: null });
  });

  it('scopes every read to its source', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({ sourceId: 'src-b', count: 7 }));
    const a = await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + DAY });
    const b = await repo.getContacts({ sourceId: 'src-b', fromMs: D0, toMs: D0 + DAY });
    expect(a.map((r) => r.receptionCount)).toEqual([1]);
    expect(b.map((r) => r.receptionCount)).toEqual([7]);
  });

  it('purgeOlderThan drops days before the cutoff; deleteForSource removes one source only', async () => {
    const repo = getRepo();
    await repo.applyDelta(delta());
    await repo.applyDelta(delta({ dayBucket: D0 + DAY, firstHeardAt: T0 + DAY, lastHeardAt: T0 + DAY }));
    await repo.applyDelta(delta({ sourceId: 'src-b' }));
    expect(await repo.purgeOlderThan(D0 + DAY)).toBe(2);
    expect(await repo.purgeOlderThan(D0 + DAY)).toBe(0);
    expect(await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + 2 * DAY })).toHaveLength(1);

    await repo.applyDelta(delta({ sourceId: 'src-b', dayBucket: D0 + DAY, firstHeardAt: T0 + DAY, lastHeardAt: T0 + DAY }));
    expect(await repo.deleteForSource('src-b')).toBe(1);
    expect(await repo.getContacts({ sourceId: 'src-b', fromMs: D0, toMs: D0 + 2 * DAY })).toHaveLength(0);
    expect(await repo.getContacts({ sourceId: 'src-a', fromMs: D0, toMs: D0 + 2 * DAY })).toHaveLength(1);
  });

  it('refuses an empty sourceId', async () => {
    const repo = getRepo();
    await expect(repo.getContacts({ sourceId: '', fromMs: 0, toMs: 1 })).rejects.toThrow();
    await expect(repo.applyDelta(delta({ sourceId: '' }))).rejects.toThrow();
    await expect(repo.deleteForSource('')).rejects.toThrow();
  });
}

describe('DirectRfContactsRepository — SQLite (migration registry)', () => {
  let sqlite: Database.Database;
  let repo: DirectRfContactsRepository;
  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    repo = new DirectRfContactsRepository(t.db, 'sqlite');
  });
  afterEach(() => sqlite.close());
  runSharedTests(() => repo);
});

describe.skipIf(!postgresAvailable)('DirectRfContactsRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: DirectRfContactsRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('directrf');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration233Postgres(client);
    } finally {
      client.release();
    }
    repo = new DirectRfContactsRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE direct_rf_contacts RESTART IDENTITY'); });
  runSharedTests(() => repo);
});

describe.skipIf(!mysqlAvailable)('DirectRfContactsRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: DirectRfContactsRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('directrf');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration233Mysql(pool);
    repo = new DirectRfContactsRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE direct_rf_contacts'); });
  runSharedTests(() => repo);
});
