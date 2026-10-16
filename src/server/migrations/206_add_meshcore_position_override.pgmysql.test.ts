/**
 * Migration 206 — PostgreSQL / MySQL container behaviour (isolated DBs).
 * A silent skip still reports success; confirm via `numPendingTests`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration206Postgres, runMigration206Mysql } from './206_add_meshcore_position_override.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 206 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig206'));
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

  it('adds the columns, is idempotent, and round-trips an override', async () => {
    const client = await pool.connect();
    try {
      await runMigration206Postgres(client);
      await expect(runMigration206Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows: before } = await pool.query(`SELECT latitude, "positionOverrideEnabled", "latitudeOverride", "positionOverrideIsPrivate" FROM meshcore_nodes`);
    expect(before[0]).toEqual({ latitude: 45.5, positionOverrideEnabled: false, latitudeOverride: null, positionOverrideIsPrivate: false });

    await pool.query(`UPDATE meshcore_nodes SET "positionOverrideEnabled" = TRUE, "latitudeOverride" = 28.123456789, "longitudeOverride" = -81.5, "altitudeOverride" = 30, "positionOverrideIsPrivate" = TRUE`);
    const { rows: after } = await pool.query(`SELECT latitude, "positionOverrideEnabled", "latitudeOverride", "longitudeOverride", "altitudeOverride", "positionOverrideIsPrivate" FROM meshcore_nodes`);
    expect(after[0]).toEqual({
      latitude: 45.5,
      positionOverrideEnabled: true,
      latitudeOverride: 28.123456789,
      longitudeOverride: -81.5,
      altitudeOverride: 30,
      positionOverrideIsPrivate: true,
    });
  });
});

describe.skipIf(!mysqlAvailable)('migration 206 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig206'));
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

  it('adds the columns, is idempotent, and round-trips an override', async () => {
    await runMigration206Mysql(pool);
    await expect(runMigration206Mysql(pool)).resolves.toBeUndefined();
    const [before] = await pool.query(`SELECT latitude, positionOverrideEnabled, latitudeOverride, positionOverrideIsPrivate FROM meshcore_nodes`);
    const b = (before as any[])[0];
    expect(b.latitude).toBe(45.5);
    expect(Number(b.positionOverrideEnabled)).toBe(0);
    expect(b.latitudeOverride).toBeNull();
    expect(Number(b.positionOverrideIsPrivate)).toBe(0);

    await pool.query(`UPDATE meshcore_nodes SET positionOverrideEnabled = TRUE, latitudeOverride = 28.123456789, longitudeOverride = -81.5, altitudeOverride = 30, positionOverrideIsPrivate = TRUE`);
    const [after] = await pool.query(`SELECT positionOverrideEnabled, latitudeOverride, longitudeOverride, altitudeOverride, positionOverrideIsPrivate FROM meshcore_nodes`);
    const a = (after as any[])[0];
    expect(Number(a.positionOverrideEnabled)).toBe(1);
    expect(a.latitudeOverride).toBe(28.123456789);
    expect(a.longitudeOverride).toBe(-81.5);
    expect(a.altitudeOverride).toBe(30);
    expect(Number(a.positionOverrideIsPrivate)).toBe(1);
  });
});
