/**
 * CrossSourceLinksRepository (#5561) on SQLite, PostgreSQL and MySQL.
 *
 * The PG/MySQL tables are built by the real migration-190 runners, not
 * hand-written DDL, each in its OWN isolated database (`xslinks`) so this
 * suite can run next to any other container suite (CLAUDE.md "PG/MySQL
 * fixture races").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import type Database from 'better-sqlite3';
import * as schema from '../schema/index.js';
import {
  CrossSourceLinksRepository,
  crossSourceLinkBucket,
  CROSS_SOURCE_LINK_BUCKET_MS,
  type RecordCrossSourceHearingParams,
} from './crossSourceLinks.js';
import { runMigration190Postgres, runMigration190Mysql } from '../../server/migrations/190_create_cross_source_links.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const HOUR = CROSS_SOURCE_LINK_BUCKET_MS;
const T0 = crossSourceLinkBucket(1_760_000_000_000) + 5 * 60_000; // 5 min into a bucket

function hearing(o: Partial<RecordCrossSourceHearingParams> = {}): RecordCrossSourceHearingParams {
  return {
    txSourceId: 'src-a', txNodeId: '!aaaaaaaa', rxSourceId: 'src-b', rxNodeId: '!bbbbbbbb',
    protocol: 'meshtastic', kind: 'origin', transportClass: 'rf', snr: 4, rssi: -90, heardAt: T0,
    ...o,
  };
}

function runSharedTests(getRepo: () => CrossSourceLinksRepository) {
  it('folds hearings in one hour into one bucket with count, min/avg/max', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing({ snr: 2, rssi: -100 }));
    await repo.recordHearing(hearing({ snr: 8, rssi: -80, heardAt: T0 + 60_000 }));
    await repo.recordHearing(hearing({ snr: null, rssi: null, heardAt: T0 + 120_000 }));

    const rows = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: T0 - HOUR });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      txSourceId: 'src-a', rxSourceId: 'src-b', kind: 'origin', transportClass: 'rf',
      hourBucket: crossSourceLinkBucket(T0),
      count: 3, snrMin: 2, snrMax: 8, snrAvg: 5, snrCount: 2, rssiAvg: -90, rssiCount: 2,
      lastHeardAt: T0 + 120_000,
    });
    expect(typeof rows[0].hourBucket).toBe('number');
  });

  it('a hearing with no readings counts but leaves the stats null', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing({ snr: null, rssi: null }));
    const [row] = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: 0 });
    expect(row).toMatchObject({ count: 1, snrMin: null, snrAvg: null, snrMax: null, snrCount: 0, rssiAvg: null, rssiCount: 0 });
  });

  it('separate buckets per hour, kind, transport and receiver node', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing());
    await repo.recordHearing(hearing({ heardAt: T0 + HOUR }));
    await repo.recordHearing(hearing({ kind: 'relay' }));
    await repo.recordHearing(hearing({ transportClass: 'mqtt_gateway', rxNodeId: '!cccccccc' }));
    const rows = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: 0 });
    expect(rows).toHaveLength(4);
  });

  it('getLinks requires BOTH ends in the source list (two-source read rule)', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing());
    await repo.recordHearing(hearing({ rxSourceId: 'src-c' }));
    expect(await repo.getLinks({ sourceIds: ['src-b'], sinceMs: 0 })).toEqual([]);
    expect(await repo.getLinks({ sourceIds: ['src-a'], sinceMs: 0 })).toEqual([]);
    expect(await repo.getLinks({ sourceIds: [], sinceMs: 0 })).toEqual([]);
    const ab = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: 0 });
    expect(ab.map((r) => r.rxSourceId)).toEqual(['src-b']);
  });

  it('getLinks honours the window start', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing({ heardAt: T0 - 3 * HOUR }));
    await repo.recordHearing(hearing());
    const rows = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: T0 - HOUR });
    expect(rows).toHaveLength(1);
    expect(rows[0].hourBucket).toBe(crossSourceLinkBucket(T0));
  });

  it('purgeOlderThan drops only buckets before the cutoff', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing({ heardAt: T0 - 48 * HOUR }));
    await repo.recordHearing(hearing());
    expect(await repo.purgeOlderThan(T0 - 24 * HOUR)).toBe(1);
    expect(await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: 0 })).toHaveLength(1);
  });

  it('deleteForSource removes rows on either end; deleteAll clears the table', async () => {
    const repo = getRepo();
    await repo.recordHearing(hearing());                                              // a -> b
    await repo.recordHearing(hearing({ txSourceId: 'src-b', txNodeId: '!bbbbbbbb', rxSourceId: 'src-a', rxNodeId: '!aaaaaaaa' })); // b -> a
    await repo.recordHearing(hearing({ txSourceId: 'src-c', txNodeId: '!cccccccc', rxSourceId: 'src-d', rxNodeId: '!dddddddd' })); // c -> d
    expect(await repo.deleteForSource('src-a')).toBe(2);
    expect(await repo.getLinks({ sourceIds: ['src-a', 'src-b', 'src-c', 'src-d'], sinceMs: 0 })).toHaveLength(1);
    expect(await repo.deleteAll()).toBe(1);
  });

  it('round-trips 64-hex MeshCore node ids', async () => {
    const repo = getRepo();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    await repo.recordHearing(hearing({ txNodeId: a, rxNodeId: b, protocol: 'meshcore' }));
    const [row] = await repo.getLinks({ sourceIds: ['src-a', 'src-b'], sinceMs: 0 });
    expect(row).toMatchObject({ txNodeId: a, rxNodeId: b, protocol: 'meshcore' });
  });

  it('rejects a hearing whose tx and rx source are the same', async () => {
    await expect(getRepo().recordHearing(hearing({ rxSourceId: 'src-a' }))).rejects.toThrow();
  });
}

describe('CrossSourceLinksRepository — SQLite (migration registry)', () => {
  let sqlite: Database.Database;
  let repo: CrossSourceLinksRepository;
  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    repo = new CrossSourceLinksRepository(t.db, 'sqlite');
  });
  afterEach(() => sqlite.close());
  runSharedTests(() => repo);
});

describe.skipIf(!postgresAvailable)('CrossSourceLinksRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CrossSourceLinksRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedPostgresDatabase('xslinks');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    const client = await pool.connect();
    try {
      await runMigration190Postgres(client);
      await runMigration190Postgres(client); // idempotent
    } finally {
      client.release();
    }
    repo = new CrossSourceLinksRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE cross_source_links RESTART IDENTITY'); });
  runSharedTests(() => repo);
});

describe.skipIf(!mysqlAvailable)('CrossSourceLinksRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: CrossSourceLinksRepository;

  beforeAll(async () => {
    const isolated = await createIsolatedMysqlDatabase('xslinks');
    pool = isolated.pool;
    cleanupDb = isolated.cleanup;
    await runMigration190Mysql(pool);
    await runMigration190Mysql(pool); // idempotent
    repo = new CrossSourceLinksRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });
  afterAll(async () => { await cleanupDb?.(); });
  beforeEach(async () => { await pool.query('TRUNCATE TABLE cross_source_links'); });
  runSharedTests(() => repo);
});
