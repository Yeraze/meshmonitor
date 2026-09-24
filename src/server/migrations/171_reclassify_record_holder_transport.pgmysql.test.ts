/**
 * Migration 171 — PostgreSQL / MySQL container behaviour (#5101).
 *
 * DDL = `traceroutes` + `route_segments` from `traceroutes.test.ts`
 * (POSTGRES_CREATE / MYSQL_CREATE) already including the 169/170 columns —
 * this suite is about the DATA step, not the column ALTERs (those are
 * covered by 169/170's own pgmysql suites). Own isolated database per
 * dialect (CLAUDE.md Multi-Database).
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration171Postgres, runMigration171Mysql } from './171_reclassify_record_holder_transport.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';
import { TX_LORA } from '../../utils/nodeTransport.js';

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS route_segments CASCADE;
  DROP TABLE IF EXISTS traceroutes CASCADE;
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    route TEXT,
    "routeBack" TEXT,
    "snrTowards" TEXT,
    "snrBack" TEXT,
    "routePositions" TEXT,
    channel INTEGER,
    "packetId" BIGINT,
    "transportMechanism" INTEGER,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
  CREATE TABLE route_segments (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "distanceKm" REAL NOT NULL,
    "isRecordHolder" BOOLEAN DEFAULT FALSE,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT,
    "transportMechanism" INTEGER
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS route_segments;
  DROP TABLE IF EXISTS traceroutes;
  CREATE TABLE traceroutes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INT,
    packetId BIGINT,
    transportMechanism INT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  );
  CREATE TABLE route_segments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    distanceKm DOUBLE NOT NULL,
    isRecordHolder BOOLEAN DEFAULT FALSE,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36),
    transportMechanism INT
  );
`;

describe.skipIf(!postgresAvailable)('migration 171 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig171'));
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    await pool.query(POSTGRES_CREATE);
  });

  it('reclassifies an RF record and its twin, runs twice safely, and demotes a NULL-source RF collision', async () => {
    await pool.query(`
      INSERT INTO traceroutes ("fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", route, "snrTowards", "transportMechanism", timestamp, "createdAt", "sourceId")
      VALUES (100, 200, '!100', '!200', '[10]', '[40,60]', ${TX_LORA}, 1000, 1000, 'src-a')
    `);
    await pool.query(`
      INSERT INTO route_segments ("fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", "distanceKm", "isRecordHolder", timestamp, "createdAt", "sourceId")
      VALUES (200, 10, '!200', '!10', 5.0, true, 1000, 1000, 'src-a'),
             (200, 10, '!200', '!10', 5.0, false, 1000, 1000, 'src-a')
    `);
    // NULL-source RF collision.
    await pool.query(`
      INSERT INTO route_segments ("fromNodeNum", "toNodeNum", "fromNodeId", "toNodeId", "distanceKm", "isRecordHolder", timestamp, "createdAt", "sourceId")
      VALUES (500, 600, '!500', '!600', 15.0, true, 3000, 3000, NULL),
             (700, 800, '!700', '!800', 25.0, true, 3000, 3000, NULL)
    `);

    const client1 = await pool.connect();
    try {
      await runMigration171Postgres(client1);
    } finally {
      client1.release();
    }

    const record = await pool.query(`SELECT "transportMechanism", "isRecordHolder" FROM route_segments WHERE "fromNodeNum" = 200 AND "isRecordHolder" = true`);
    expect(Number(record.rows[0].transportMechanism)).toBe(TX_LORA);

    const twin = await pool.query(`SELECT "transportMechanism" FROM route_segments WHERE "fromNodeNum" = 200 AND "isRecordHolder" = false`);
    expect(Number(twin.rows[0].transportMechanism)).toBe(TX_LORA);

    const nullSourceShort = await pool.query(`SELECT "isRecordHolder" FROM route_segments WHERE "fromNodeNum" = 500`);
    expect(nullSourceShort.rows[0].isRecordHolder).toBe(false);
    const nullSourceLong = await pool.query(`SELECT "isRecordHolder" FROM route_segments WHERE "fromNodeNum" = 700`);
    expect(nullSourceLong.rows[0].isRecordHolder).toBe(true);

    const before = await pool.query(`SELECT * FROM route_segments ORDER BY id`);
    const client2 = await pool.connect();
    try {
      await runMigration171Postgres(client2);
    } finally {
      client2.release();
    }
    const after = await pool.query(`SELECT * FROM route_segments ORDER BY id`);
    expect(after.rows).toEqual(before.rows);
  });
});

describe.skipIf(!mysqlAvailable)('migration 171 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig171'));
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(async () => {
    for (const stmt of MYSQL_CREATE.split(';').map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
  });

  it('reclassifies an RF record and its twin, runs twice safely, and demotes a NULL-source RF collision', async () => {
    await pool.query(`
      INSERT INTO traceroutes (fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, snrTowards, transportMechanism, timestamp, createdAt, sourceId)
      VALUES (100, 200, '!100', '!200', '[10]', '[40,60]', ${TX_LORA}, 1000, 1000, 'src-a')
    `);
    await pool.query(`
      INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt, sourceId)
      VALUES (200, 10, '!200', '!10', 5.0, true, 1000, 1000, 'src-a'),
             (200, 10, '!200', '!10', 5.0, false, 1000, 1000, 'src-a')
    `);
    await pool.query(`
      INSERT INTO route_segments (fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt, sourceId)
      VALUES (500, 600, '!500', '!600', 15.0, true, 3000, 3000, NULL),
             (700, 800, '!700', '!800', 25.0, true, 3000, 3000, NULL)
    `);

    await runMigration171Mysql(pool);

    const [record] = await pool.query(`SELECT transportMechanism, isRecordHolder FROM route_segments WHERE fromNodeNum = 200 AND isRecordHolder = true`);
    expect(Number((record as Record<string, unknown>[])[0].transportMechanism)).toBe(TX_LORA);

    const [twin] = await pool.query(`SELECT transportMechanism FROM route_segments WHERE fromNodeNum = 200 AND isRecordHolder = false`);
    expect(Number((twin as Record<string, unknown>[])[0].transportMechanism)).toBe(TX_LORA);

    const [nullSourceShort] = await pool.query(`SELECT isRecordHolder FROM route_segments WHERE fromNodeNum = 500`);
    expect(Number((nullSourceShort as Record<string, unknown>[])[0].isRecordHolder)).toBe(0);
    const [nullSourceLong] = await pool.query(`SELECT isRecordHolder FROM route_segments WHERE fromNodeNum = 700`);
    expect(Number((nullSourceLong as Record<string, unknown>[])[0].isRecordHolder)).toBe(1);

    const [before] = await pool.query(`SELECT * FROM route_segments ORDER BY id`);
    await runMigration171Mysql(pool);
    const [after] = await pool.query(`SELECT * FROM route_segments ORDER BY id`);
    expect(after).toEqual(before);
  });
});
