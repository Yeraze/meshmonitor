/**
 * Migration 194 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration194Postgres, runMigration194Mysql } from './194_add_meshcore_last_advert_had_position.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 194 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig194'));
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        "publicKey" TEXT NOT NULL,
        "sourceId" TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        "createdAt" BIGINT NOT NULL,
        "updatedAt" BIGINT NOT NULL,
        PRIMARY KEY ("sourceId", "publicKey")
      )
    `);
    await pool.query(`INSERT INTO meshcore_nodes ("publicKey", "sourceId", latitude, longitude, "createdAt", "updatedAt") VALUES ('k', 'src-a', 45.5, -75.5, 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable boolean, is idempotent, and round-trips false', async () => {
    const client = await pool.connect();
    try {
      await runMigration194Postgres(client);
      await expect(runMigration194Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT latitude, longitude, "lastAdvertHadPosition" FROM meshcore_nodes`);
    expect(before[0]).toEqual({ latitude: 45.5, longitude: -75.5, lastAdvertHadPosition: null });

    await pool.query(`UPDATE meshcore_nodes SET "lastAdvertHadPosition" = FALSE`);
    const { rows: off } = await pool.query(`SELECT "lastAdvertHadPosition" FROM meshcore_nodes`);
    expect(off[0].lastAdvertHadPosition).toBe(false);

    await pool.query(`UPDATE meshcore_nodes SET "lastAdvertHadPosition" = TRUE`);
    const { rows: on } = await pool.query(`SELECT "lastAdvertHadPosition" FROM meshcore_nodes`);
    expect(on[0].lastAdvertHadPosition).toBe(true);
  });
});

describe.skipIf(!mysqlAvailable)('migration 194 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig194'));
    await pool.query(`
      CREATE TABLE meshcore_nodes (
        publicKey VARCHAR(64) NOT NULL,
        sourceId VARCHAR(64) NOT NULL,
        latitude DOUBLE,
        longitude DOUBLE,
        createdAt BIGINT NOT NULL,
        updatedAt BIGINT NOT NULL,
        PRIMARY KEY (sourceId, publicKey)
      )
    `);
    await pool.query(`INSERT INTO meshcore_nodes (publicKey, sourceId, latitude, longitude, createdAt, updatedAt) VALUES ('k', 'src-a', 45.5, -75.5, 1, 1)`);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds a nullable boolean, is idempotent, and round-trips false', async () => {
    await runMigration194Mysql(pool);
    await expect(runMigration194Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT latitude, longitude, lastAdvertHadPosition FROM meshcore_nodes`);
    expect((before as any[])[0]).toEqual({ latitude: 45.5, longitude: -75.5, lastAdvertHadPosition: null });

    await pool.query(`UPDATE meshcore_nodes SET lastAdvertHadPosition = FALSE`);
    const [off] = await pool.query(`SELECT lastAdvertHadPosition FROM meshcore_nodes`);
    expect(Number((off as any[])[0].lastAdvertHadPosition)).toBe(0);

    await pool.query(`UPDATE meshcore_nodes SET lastAdvertHadPosition = TRUE`);
    const [on] = await pool.query(`SELECT lastAdvertHadPosition FROM meshcore_nodes`);
    expect(Number((on as any[])[0].lastAdvertHadPosition)).toBe(1);
  });
});
