/**
 * Grouped packet queries across PostgreSQL and MySQL (#5040 Phase 2).
 *
 * The SQLite suite (`meshcorePacketLog.grouped.test.ts`) proves the semantics.
 * This one proves the SQL is portable, because the grouping key is the one
 * piece of hand-written SQL in the feature:
 *
 *   COALESCE(rawHex, CAST(-id AS CHAR(24)))
 *
 * That coalesces a TEXT column with a number, so it needs an explicit cast, and
 * the three backends disagree about cast type names. `CHAR` is the portable
 * spelling: MySQL accepts only its own list (BINARY, CHAR, DECIMAL, SIGNED …
 * and NOT `TEXT`), PostgreSQL accepts CHAR as bpchar, and SQLite resolves any
 * type name containing "CHAR" to TEXT affinity. Writing `CAST(… AS TEXT)`
 * instead — which reads more natural — is a **syntax error on MySQL**.
 *
 * A review of #5046 raised exactly this portability question, and the honest
 * answer was that the grouped query was only ever exercised on SQLite. These
 * tests close that: the same assertions run on the real containers.
 *
 * The fixture runs in its OWN throwaway database (`createIsolated*Database`),
 * not the shared `meshmonitor_test`. Migration 158's container half DROP/CREATEs
 * the same `meshcore_packet_log` table; on the shared database whichever
 * finished first dropped it out from under the other. Keep the isolation — see
 * the "Per-suite fixture isolation" banner in test-utils.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { MeshCoreRepository, type DbMeshCorePacket } from './meshcore.js';
import * as schema from '../schema/index.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from './test-utils.js';

const FRAME_A = '0500deadbeef';
const FRAME_B = '0500cafebabe';
const OBS_1 = 'AA'.repeat(32);
const OBS_2 = 'BB'.repeat(32);

function packet(overrides: Partial<DbMeshCorePacket> = {}): DbMeshCorePacket {
  const now = 1_700_000_000_000;
  return {
    sourceId: 'src-mqtt',
    timestamp: now,
    payloadType: 2,
    payloadTypeName: 'TXT_MSG',
    routeType: 1,
    routeTypeName: 'FLOOD',
    pathLenRaw: 0x41,
    hopCount: 1,
    pathHops: 'a3',
    snr: 1,
    rssi: -100,
    payloadSize: 24,
    rawHex: FRAME_A,
    createdAt: now,
    ...overrides,
  };
}

/** Assertions shared by both backends, so neither can drift from the other. */
function sharedGroupedBehaviour(getRepo: () => MeshCoreRepository) {
  it('collapses observer receptions and reports the best signal', async () => {
    const repo = getRepo();
    await repo.insertPacket(packet({ observerId: OBS_1, snr: -9, rssi: -120, timestamp: 100 }));
    await repo.insertPacket(packet({ observerId: OBS_2, snr: 3.5, rssi: -70, timestamp: 200 }));

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(grouped).toHaveLength(1);
    expect(Number(grouped[0].observerCount)).toBe(2);
    expect(Number(grouped[0].receptionCount)).toBe(2);
    expect(Number(grouped[0].bestSnr)).toBe(3.5);
    expect(Number(grouped[0].bestRssi)).toBe(-70);
    expect(Number(grouped[0].firstHeard)).toBe(100);
    expect(Number(grouped[0].lastHeard)).toBe(200);
  });

  it('keeps distinct frames apart and counts groups not rows', async () => {
    const repo = getRepo();
    await repo.insertPacket(packet({ rawHex: FRAME_A, observerId: OBS_1 }));
    await repo.insertPacket(packet({ rawHex: FRAME_A, observerId: OBS_2 }));
    await repo.insertPacket(packet({ rawHex: FRAME_B, observerId: OBS_1 }));

    expect(await repo.getGroupedPackets({ sourceId: 'src-mqtt' })).toHaveLength(2);
    expect(Number(await repo.getGroupedPacketCount({ sourceId: 'src-mqtt' }))).toBe(2);
    expect(Number(await repo.getPacketCount({ sourceId: 'src-mqtt' }))).toBe(3);
  });

  it('does NOT collapse rows that lack a rawHex — the CAST fallback must yield distinct keys', async () => {
    // The portability assertion that matters. If the cast silently produced
    // NULL, GROUP BY would treat the rows as equal and merge them into one
    // bogus entry — which is exactly the failure a wrong cast type name gives.
    const repo = getRepo();
    await repo.insertPacket(packet({ rawHex: null, observerId: OBS_1 }));
    await repo.insertPacket(packet({ rawHex: null, observerId: OBS_2 }));

    expect(await repo.getGroupedPackets({ sourceId: 'src-mqtt' })).toHaveLength(2);
  });

  it('reports observerCount 0 for a locally-heard frame', async () => {
    const repo = getRepo();
    await repo.insertPacket(packet({ observerId: null }));
    const [g] = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(Number(g.observerCount)).toBe(0);
    expect(Number(g.receptionCount)).toBe(1);
  });
}

const PG_CREATE = `
  DROP TABLE IF EXISTS meshcore_packet_log CASCADE;
  CREATE TABLE meshcore_packet_log (
    id SERIAL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    "payloadType" INTEGER NOT NULL,
    "payloadTypeName" TEXT,
    "routeType" INTEGER,
    "routeTypeName" TEXT,
    "pathLenRaw" INTEGER,
    "hopCount" INTEGER,
    "pathHops" TEXT,
    snr REAL,
    rssi INTEGER,
    "payloadSize" INTEGER,
    "rawHex" TEXT,
    "observerId" TEXT,
    "createdAt" BIGINT NOT NULL
  );
`;

const MYSQL_CREATE = `
  CREATE TABLE meshcore_packet_log (
    id SERIAL PRIMARY KEY,
    sourceId VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL,
    payloadType INT NOT NULL,
    payloadTypeName VARCHAR(32),
    routeType INT,
    routeTypeName VARCHAR(32),
    pathLenRaw INT,
    hopCount INT,
    pathHops VARCHAR(512),
    snr DOUBLE,
    rssi INT,
    payloadSize INT,
    rawHex TEXT,
    observerId VARCHAR(64),
    createdAt BIGINT NOT NULL
  );
`;

describe.skipIf(!postgresAvailable)('grouped packet queries — PostgreSQL', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('r_meshcorepacketlog_grp'));
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
    await pool.query(PG_CREATE);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_packet_log CASCADE');
      await cleanup?.();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_packet_log');
  });

  sharedGroupedBehaviour(() => repo);
});

describe.skipIf(!mysqlAvailable)('grouped packet queries — MySQL', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('r_meshcorepacketlog_grp'));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
    await pool.query('DROP TABLE IF EXISTS meshcore_packet_log');
    await pool.query(MYSQL_CREATE);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS meshcore_packet_log');
      await cleanup?.();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_packet_log');
  });

  sharedGroupedBehaviour(() => repo);
});
