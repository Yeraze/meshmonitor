/**
 * Migration 220 — meshcore_nodes retry-burst / cooldown state (#6033).
 *
 * SQLite always runs. The PostgreSQL / MySQL blocks skip silently when the
 * containers (localhost:5433 / :3307) are down; each owns an isolated database.
 * A minimal `meshcore_nodes` stand-in table is enough — the migration only
 * adds columns.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration, runMigration220Postgres, runMigration220Mysql } from './220_add_meshcore_telemetry_retry_state.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe('Migration 220 — SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      `CREATE TABLE meshcore_nodes (sourceId TEXT, publicKey TEXT, telemetryEnabled INTEGER, lastTelemetryRequestAt INTEGER)`,
    );
    db.exec(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', 1, 123)`);
  });

  it('adds the three retry-state columns; miss-count defaults 0, others null', () => {
    migration.up(db);
    const row = db.prepare(`SELECT * FROM meshcore_nodes`).get() as any;
    expect(row.lastTelemetrySuccessAt).toBeNull();
    expect(row.telemetryMissCount).toBe(0);
    expect(row.telemetryCooldownUntil).toBeNull();
    expect(row.lastTelemetryRequestAt).toBe(123);
  });

  it('is idempotent', () => {
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(meshcore_nodes)`).all() as any[]).filter((c) =>
      ['lastTelemetrySuccessAt', 'telemetryMissCount', 'telemetryCooldownUntil'].includes(c.name),
    );
    expect(cols).toHaveLength(3);
  });
});

describe.skipIf(!postgresAvailable)('Migration 220 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig220'));
    await pool.query(
      `CREATE TABLE IF NOT EXISTS meshcore_nodes ("sourceId" TEXT, "publicKey" TEXT, "telemetryEnabled" BOOLEAN, "lastTelemetryRequestAt" BIGINT)`,
    );
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', true, 123)`);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('adds the columns, is idempotent, and defaults miss-count to 0', async () => {
    const client = await pool.connect();
    try {
      await runMigration220Postgres(client);
      await expect(runMigration220Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`SELECT * FROM meshcore_nodes`);
    expect(rows[0].lastTelemetrySuccessAt).toBeNull();
    expect(Number(rows[0].telemetryMissCount)).toBe(0);
    expect(rows[0].telemetryCooldownUntil).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('Migration 220 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig220'));
    await pool.query(
      `CREATE TABLE IF NOT EXISTS meshcore_nodes (sourceId VARCHAR(64), publicKey VARCHAR(64), telemetryEnabled BOOLEAN, lastTelemetryRequestAt BIGINT)`,
    );
    await pool.query(`INSERT INTO meshcore_nodes VALUES ('src-1', 'aa', true, 123)`);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('adds the columns, is idempotent, and defaults miss-count to 0', async () => {
    await runMigration220Mysql(pool);
    await expect(runMigration220Mysql(pool)).resolves.toBeUndefined();
    const [rows] = await pool.query(`SELECT * FROM meshcore_nodes`);
    expect((rows as any[])[0].lastTelemetrySuccessAt).toBeNull();
    expect(Number((rows as any[])[0].telemetryMissCount)).toBe(0);
    expect((rows as any[])[0].telemetryCooldownUntil).toBeNull();
  });
});
