/** Contact hop/signal samples on PostgreSQL and MySQL containers (#6262). */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase } from './test-utils.js';

const KEY = 'aa'.repeat(32);

// Only the columns the two reads touch; selects are explicit so this is enough.
const PG_CREATE = `CREATE TABLE meshcore_messages (
  id TEXT PRIMARY KEY, "fromPublicKey" TEXT NOT NULL, timestamp BIGINT NOT NULL,
  rssi INTEGER, snr REAL, "hopCount" INTEGER, "reactionEmoji" TEXT, "sourceId" TEXT)`;
const MYSQL_CREATE = `CREATE TABLE meshcore_messages (
  id VARCHAR(64) PRIMARY KEY, fromPublicKey VARCHAR(64) NOT NULL, timestamp BIGINT NOT NULL,
  rssi INT, snr DOUBLE, hopCount INT, reactionEmoji TEXT, sourceId VARCHAR(255))`;

const ROWS: Array<[string, number, number | null, number | null, number | null, string]> = [
  ['1', 3000, 2, 5.5, -90, 'a'],
  ['2', 2000, 1, 7, null as never, 'a'],
  ['3', 2100, 6, -3, -120, 'b'],
];

function behaviour(getRepo: () => MeshCoreRepository) {
  it('scopes by source and orders correctly', async () => {
    const repo = getRepo();
    expect(await repo.getContactHopSamples('a', KEY, 0)).toEqual([
      { timestamp: 2000, value: 1 },
      { timestamp: 3000, value: 2 },
    ]);
    expect(await repo.getContactHopSamples('b', KEY, 0)).toEqual([{ timestamp: 2100, value: 6 }]);
    expect(await repo.getContactSignalSamples('a', KEY, 0)).toEqual([
      { timestamp: 3000, snr: 5.5, rssi: -90 },
      { timestamp: 2000, snr: 7, rssi: null },
    ]);
    await expect(repo.getContactHopSamples('', KEY, 0)).rejects.toThrow(/sourceId/);
  });
}

describe.skipIf(!postgresAvailable)('contact samples — PostgreSQL', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('r_mccontactsamples'));
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
    await pool.query(PG_CREATE);
  });
  afterAll(async () => { if (pool) await cleanup?.(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_messages');
    for (const [id, ts, hop, snr, rssi, src] of ROWS) {
      await pool.query(
        `INSERT INTO meshcore_messages (id,"fromPublicKey",timestamp,"hopCount",snr,rssi,"sourceId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, KEY, ts, hop, snr, rssi, src]
      );
    }
  });
  behaviour(() => repo);
});

describe.skipIf(!mysqlAvailable)('contact samples — MySQL', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('r_mccontactsamples'));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
    await pool.query(MYSQL_CREATE);
  });
  afterAll(async () => { if (pool) await cleanup?.(); });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_messages');
    for (const [id, ts, hop, snr, rssi, src] of ROWS) {
      await pool.query(
        `INSERT INTO meshcore_messages (id,fromPublicKey,timestamp,hopCount,snr,rssi,sourceId) VALUES (?,?,?,?,?,?,?)`,
        [id, KEY, ts, hop, snr, rssi, src]
      );
    }
  });
  behaviour(() => repo);
});
