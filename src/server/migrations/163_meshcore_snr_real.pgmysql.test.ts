/**
 * Migration 163 — PostgreSQL / MySQL container behaviour (#5175).
 *
 * MeshCore SNR is quarter-dB fractional (e.g. -8.25). Both `meshcore_messages`
 * and `meshcore_heard_repeaters` declared `snr` as a 32-bit INTEGER on
 * PostgreSQL/MySQL, so a production insert of a real MeshCore message failed
 * outright on PostgreSQL:
 *
 *   error: invalid input syntax for type integer: "-8.25"
 *
 * This test builds each table in its pre-163 (INTEGER `snr`) shape — matching
 * the historical DDL in 001_v37_baseline.ts / 102_create_meshcore_heard_repeaters.ts
 * — runs migration 163 against it, then round-trips a fractional SNR through
 * the real Drizzle table object to prove the column actually accepts it.
 *
 * **Isolation.** Own PostgreSQL schema, own MySQL database (CLAUDE.md
 * Multi-Database: two suites creating/dropping the same table name in one test
 * database is an active race, not a flake).
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { drizzle as drizzlePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import { meshcoreMessagesPostgres, meshcoreMessagesMysql } from '../../db/schema/meshcoreMessages.js';
import { meshcoreHeardRepeatersPostgres, meshcoreHeardRepeatersMysql } from '../../db/schema/meshcoreHeardRepeaters.js';
import { runMigration163Postgres, runMigration163Mysql } from './163_meshcore_snr_real.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

const PG_SCHEMA = 'meshcore_snr_migration_163';
const MYSQL_DB = 'meshmonitor_test_meshcore_snr_163';

const NOW = 1_800_000_000_000;

describe.skipIf(!postgresAvailable)('migration 163 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;
  let db: ReturnType<typeof drizzlePostgres>;

  beforeAll(async () => {
    const admin = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
    });
    await admin.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${PG_SCHEMA}`);
    await admin.end();

    pool = new PgPool({
      host: 'localhost', port: 5433, user: 'test', password: 'test', database: 'meshmonitor_test',
      options: `-c search_path=${PG_SCHEMA}`,
    });
    db = drizzlePostgres(pool, { schema });

    // Pre-163 shape: snr INTEGER, matching the historical baseline DDL.
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE meshcore_messages (
          id TEXT PRIMARY KEY,
          "fromPublicKey" TEXT NOT NULL,
          "fromName" TEXT,
          "toPublicKey" TEXT,
          text TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          rssi INTEGER,
          snr INTEGER,
          "hopCount" INTEGER,
          "routePath" TEXT,
          "scopeCode" INTEGER,
          "scopeName" TEXT,
          "messageType" TEXT DEFAULT 'text',
          delivered BOOLEAN DEFAULT false,
          "deliveredAt" BIGINT,
          "sourceId" TEXT,
          "createdAt" BIGINT NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE meshcore_heard_repeaters (
          id SERIAL PRIMARY KEY,
          "sourceId" TEXT NOT NULL,
          "messageId" TEXT NOT NULL,
          "repeaterHash" TEXT NOT NULL,
          "repeaterName" TEXT,
          snr INTEGER,
          "heardAt" BIGINT NOT NULL,
          "createdAt" BIGINT NOT NULL
        )
      `);
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
      await pool.end();
    }
  });

  it('widens meshcore_messages.snr to REAL and accepts a fractional value, and runs twice safely', async () => {
    const client = await pool.connect();
    try {
      await runMigration163Postgres(client);
      // The ledger normally runs a migration once, but a crash between the
      // migration and its ledger write re-runs it — idempotency is mandatory.
      await expect(runMigration163Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    await db.insert(meshcoreMessagesPostgres).values({
      id: 'm-163-pg',
      fromPublicKey: 'pk-1',
      text: 'fractional snr',
      timestamp: NOW,
      rssi: -116,
      snr: -8.25,
      createdAt: NOW,
    });
    const [row] = await db
      .select()
      .from(meshcoreMessagesPostgres)
      .where(eq(meshcoreMessagesPostgres.id, 'm-163-pg'));

    expect(row.rssi).toBe(-116);
    expect(row.snr).toBeCloseTo(-8.25);
  });

  it('widens meshcore_heard_repeaters.snr to REAL and accepts a fractional value', async () => {
    await db.insert(meshcoreHeardRepeatersPostgres).values({
      sourceId: 'src-a',
      messageId: 'm1',
      repeaterHash: 'a3',
      snr: 7.75,
      heardAt: NOW,
      createdAt: NOW,
    });
    const [row] = await db
      .select()
      .from(meshcoreHeardRepeatersPostgres)
      .where(eq(meshcoreHeardRepeatersPostgres.repeaterHash, 'a3'));

    expect(row.snr).toBeCloseTo(7.75);
  });
});

describe.skipIf(!mysqlAvailable)('migration 163 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let db: ReturnType<typeof drizzleMysql>;

  beforeAll(async () => {
    const admin = mysql.createPool({
      host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(`GRANT ALL ON \`${MYSQL_DB}\`.* TO 'test'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
    await admin.end();

    pool = mysql.createPool({
      host: 'localhost', port: 3307, user: 'test', password: 'test', database: MYSQL_DB, connectionLimit: 5,
    });
    db = drizzleMysql(pool, { schema, mode: 'default' });

    // Pre-163 shape: snr INT, matching the historical baseline DDL.
    await pool.query(`
      CREATE TABLE meshcore_messages (
        id VARCHAR(64) PRIMARY KEY,
        fromPublicKey VARCHAR(64) NOT NULL,
        fromName VARCHAR(64),
        toPublicKey VARCHAR(64),
        text TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        rssi INT,
        snr INT,
        hopCount INT,
        routePath TEXT,
        scopeCode INT,
        scopeName TEXT,
        messageType VARCHAR(32) DEFAULT 'text',
        delivered BOOLEAN DEFAULT false,
        deliveredAt BIGINT,
        sourceId VARCHAR(64),
        createdAt BIGINT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE meshcore_heard_repeaters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sourceId VARCHAR(64) NOT NULL,
        messageId VARCHAR(64) NOT NULL,
        repeaterHash VARCHAR(16) NOT NULL,
        repeaterName VARCHAR(128),
        snr INT,
        heardAt BIGINT NOT NULL,
        createdAt BIGINT NOT NULL
      )
    `);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = mysql.createPool({
      host: 'localhost', port: 3307, user: 'root', password: 'root', connectionLimit: 1,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.end();
  });

  it('widens meshcore_messages.snr to DOUBLE and accepts a fractional value, and runs twice safely', async () => {
    await runMigration163Mysql(pool);
    await expect(runMigration163Mysql(pool)).resolves.toBeUndefined();

    await db.insert(meshcoreMessagesMysql).values({
      id: 'm-163-mysql',
      fromPublicKey: 'pk-1',
      text: 'fractional snr',
      timestamp: NOW,
      rssi: -116,
      snr: -8.25,
      createdAt: NOW,
    });
    const [row] = await db
      .select()
      .from(meshcoreMessagesMysql)
      .where(eq(meshcoreMessagesMysql.id, 'm-163-mysql'));

    expect(row.rssi).toBe(-116);
    expect(row.snr).toBeCloseTo(-8.25);
  });

  it('widens meshcore_heard_repeaters.snr to DOUBLE and accepts a fractional value', async () => {
    await db.insert(meshcoreHeardRepeatersMysql).values({
      sourceId: 'src-a',
      messageId: 'm1',
      repeaterHash: 'a3',
      snr: 7.75,
      heardAt: NOW,
      createdAt: NOW,
    });
    const [row] = await db
      .select()
      .from(meshcoreHeardRepeatersMysql)
      .where(eq(meshcoreHeardRepeatersMysql.repeaterHash, 'a3'));

    expect(row.snr).toBeCloseTo(7.75);
  });
});
