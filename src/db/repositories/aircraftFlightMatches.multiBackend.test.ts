/**
 * AircraftFlightMatchesRepository on PostgreSQL and MySQL (#5374). The table
 * is created with the real migration-180 runners (plus 214's re-check columns); each backend uses its own
 * isolated database. Skips silently when the containers are down — confirm
 * via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import * as schema from '../schema/index.js';
import { AircraftFlightMatchesRepository } from './aircraftFlightMatches.js';
import { runMigration180Postgres, runMigration180Mysql } from '../../server/migrations/180_create_aircraft_flight_matches.js';
import { runMigration214Postgres, runMigration214Mysql } from '../../server/migrations/214_add_aircraft_flight_match_rechecks.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const NODE = 0xdeadbeef;

function runSharedTests(getRepo: () => AircraftFlightMatchesRepository) {
  it('startEpisode + recordLookup round-trip with an unsigned nodeNum and ms timestamps', async () => {
    const repo = getRepo();
    const t0 = 1_790_000_000_000;
    await repo.startEpisode('src-a', NODE, t0);
    expect(await repo.recordLookup('src-a', NODE, {
      episodeStartedAt: t0,
      lookupsBefore: 0,
      firstLookupAt: t0 + 1000,
      result: {
        status: 'possible', feed: 'adsb.fi', hex: 'a3f1c2', callsign: 'AAL1498', aircraftType: 'B38M',
        registration: 'N316RK', gsKt: 312.4, trackDeg: 271.3, altM: 3002.5, distanceKm: 1.25, matchedAt: t0 + 1000,
      },
    })).toBe(true);
    const row = await repo.get('src-a', NODE);
    expect(row).toMatchObject({
      nodeNum: NODE, episodeStartedAt: t0, lookups: 1, firstLookupAt: t0 + 1000, status: 'possible',
      hex: 'a3f1c2', gsKt: 312.4, altM: 3002.5, distanceKm: 1.25, matchedAt: t0 + 1000,
    });
    expect(await repo.get('src-b', NODE)).toBeNull();
  });

  it('conditional write refuses a stale lookup count or episode', async () => {
    const repo = getRepo();
    await repo.startEpisode('src-a', NODE, 1000);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0 })).toBe(true);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0 })).toBe(false);
    expect(await repo.recordLookup('src-a', NODE, { episodeStartedAt: 999, lookupsBefore: 1 })).toBe(false);
    expect((await repo.get('src-a', NODE))!.lookups).toBe(1);
  });

  it('startEpisode upsert resets an existing row; deleteForNode is source-scoped', async () => {
    const repo = getRepo();
    await repo.startEpisode('src-a', NODE, 1000);
    await repo.startEpisode('src-b', NODE, 1000);
    await repo.recordLookup('src-a', NODE, { episodeStartedAt: 1000, lookupsBefore: 0 });
    await repo.startEpisode('src-a', NODE, 2000);
    expect(await repo.get('src-a', NODE)).toMatchObject({ lookups: 0, episodeStartedAt: 2000, status: 'none' });
    expect(await repo.deleteForNode('src-a', NODE)).toBe(1);
    expect(await repo.get('src-a', NODE)).toBeNull();
    expect(await repo.get('src-b', NODE)).not.toBeNull();
  });

  it('recordRecheck round-trips the point and refuses a stale re-check count (#5876)', async () => {
    const repo = getRepo();
    const t0 = 1_790_000_000_000;
    await repo.startEpisode('src-a', NODE, t0);
    await repo.recordLookup('src-a', NODE, {
      episodeStartedAt: t0, lookupsBefore: 0, firstLookupAt: t0, point: { at: t0, lat: 25.8, lon: -80.3 },
    });
    expect(await repo.get('src-a', NODE)).toMatchObject({ lastLookupAt: t0, lastLookupLat: 25.8, lastLookupLon: -80.3, rechecks: 0, misses: 0 });
    const w = { episodeStartedAt: t0, rechecksBefore: 0, misses: 1, point: { at: t0 + 900_000, lat: 26.05, lon: -80.25 } };
    expect(await repo.recordRecheck('src-a', NODE, w)).toBe(true);
    expect(await repo.recordRecheck('src-a', NODE, w)).toBe(false);
    expect(await repo.recordRecheck('src-a', NODE, { ...w, rechecksBefore: 1, episodeStartedAt: t0 - 1 })).toBe(false);
    expect(await repo.get('src-a', NODE)).toMatchObject({
      rechecks: 1, misses: 1, lastLookupAt: t0 + 900_000, lastLookupLat: 26.05, lastLookupLon: -80.25,
    });
    await repo.startEpisode('src-a', NODE, t0 + 1);
    expect(await repo.get('src-a', NODE)).toMatchObject({ rechecks: 0, misses: 0, lastLookupAt: null, lastLookupLat: null });
  });
}

describe.skipIf(!postgresAvailable)('AircraftFlightMatchesRepository — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: AircraftFlightMatchesRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedPostgresDatabase('afm'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY)');
    await pool.query(`INSERT INTO sources (id) VALUES ('src-a'), ('src-b') ON CONFLICT DO NOTHING`);
    const client = await pool.connect();
    try {
      await runMigration180Postgres(client);
      await runMigration214Postgres(client);
    } finally {
      client.release();
    }
    repo = new AircraftFlightMatchesRepository(drizzlePostgres(pool, { schema }), 'postgres');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM aircraft_flight_matches');
  });

  runSharedTests(() => repo);
});

describe.skipIf(!mysqlAvailable)('AircraftFlightMatchesRepository — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanupDb: (() => Promise<void>) | undefined;
  let repo: AircraftFlightMatchesRepository;

  beforeAll(async () => {
    ({ pool, cleanup: cleanupDb } = await createIsolatedMysqlDatabase('afm'));
    await pool.query('CREATE TABLE IF NOT EXISTS sources (id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`INSERT IGNORE INTO sources (id) VALUES ('src-a'), ('src-b')`);
    await runMigration180Mysql(pool);
    await runMigration214Mysql(pool);
    repo = new AircraftFlightMatchesRepository(drizzleMysql(pool, { schema, mode: 'default' }), 'mysql');
  });

  afterAll(async () => {
    await cleanupDb?.();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM aircraft_flight_matches');
  });

  runSharedTests(() => repo);
});
