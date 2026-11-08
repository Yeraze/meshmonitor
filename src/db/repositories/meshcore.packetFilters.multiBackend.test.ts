/** Packet filters + distribution on PostgreSQL and MySQL containers (#6262). */
import { describe, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { postgresAvailable, mysqlAvailable, createIsolatedPostgresDatabase, createIsolatedMysqlDatabase } from './test-utils.js';
import { sharedPacketFilterBehaviour } from './meshcore.packetFilters.shared.js';

const PG_CREATE = `
  CREATE TABLE meshcore_packet_log (
    id SERIAL PRIMARY KEY, "sourceId" TEXT NOT NULL, timestamp BIGINT NOT NULL,
    "payloadType" INTEGER NOT NULL, "payloadTypeName" TEXT, "routeType" INTEGER, "routeTypeName" TEXT,
    "pathLenRaw" INTEGER, "hopCount" INTEGER, "pathHops" TEXT, snr REAL, rssi INTEGER,
    "payloadSize" INTEGER, "rawHex" TEXT, "observerId" TEXT, "srcHash" TEXT, "senderPubKey" TEXT,
    "advertName" TEXT, "createdAt" BIGINT NOT NULL
  )`;
const MYSQL_CREATE = `
  CREATE TABLE meshcore_packet_log (
    id SERIAL PRIMARY KEY, sourceId VARCHAR(255) NOT NULL, timestamp BIGINT NOT NULL,
    payloadType INT NOT NULL, payloadTypeName VARCHAR(32), routeType INT, routeTypeName VARCHAR(32),
    pathLenRaw INT, hopCount INT, pathHops VARCHAR(512), snr DOUBLE, rssi INT,
    payloadSize INT, rawHex TEXT, observerId VARCHAR(64), srcHash VARCHAR(8), senderPubKey VARCHAR(64),
    advertName VARCHAR(128), createdAt BIGINT NOT NULL
  )`;

describe.skipIf(!postgresAvailable)('packet filters — PostgreSQL', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('r_mcpacketfilters'));
    repo = new MeshCoreRepository(drizzlePostgres(pool, { schema }) as never, 'postgres');
    await pool.query(PG_CREATE);
  });
  afterAll(async () => {
    if (pool) await cleanup?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_packet_log');
  });
  sharedPacketFilterBehaviour(() => repo);
});

describe.skipIf(!mysqlAvailable)('packet filters — MySQL', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  let repo: MeshCoreRepository;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('r_mcpacketfilters'));
    repo = new MeshCoreRepository(drizzleMysql(pool, { schema, mode: 'default' }) as never, 'mysql');
    await pool.query(MYSQL_CREATE);
  });
  afterAll(async () => {
    if (pool) await cleanup?.();
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM meshcore_packet_log');
  });
  sharedPacketFilterBehaviour(() => repo);
});
