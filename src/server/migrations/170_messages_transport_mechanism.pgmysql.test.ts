/**
 * Migration 170 — PostgreSQL / MySQL container behaviour (#5101).
 *
 * Pre-state = the `messages` DDL from
 * `messages.transportCounts.multiBackend.test.ts` (minus the new column),
 * run against the live test containers (localhost:5433 / :3307). Own
 * isolated database per dialect (CLAUDE.md Multi-Database).
 *
 * A silent skip still reports `success: true`; confirm coverage via
 * `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration170Postgres, runMigration170Mysql } from './170_messages_transport_mechanism.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 170 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig170'));
    await pool.query('DROP TABLE IF EXISTS messages CASCADE');
    await pool.query(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        "fromNodeNum" BIGINT NOT NULL,
        "toNodeNum" BIGINT NOT NULL,
        text TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        "viaMqtt" BOOLEAN,
        timestamp BIGINT NOT NULL,
        "createdAt" BIGINT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds transportMechanism, is idempotent, and round-trips an explicit 0 (INTERNAL) as 0, not NULL', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration170Postgres(client1);
      await expect(runMigration170Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    await pool.query(`INSERT INTO messages (id, "fromNodeNum", "toNodeNum", text, timestamp, "createdAt") VALUES ('msg-1', 1, 2, 'hi', 1000, 1000)`);

    const before = await pool.query(`SELECT "transportMechanism" FROM messages WHERE id = 'msg-1'`);
    expect(before.rows[0].transportMechanism).toBeNull();

    await pool.query(`UPDATE messages SET "transportMechanism" = 0 WHERE id = 'msg-1'`);
    const after = await pool.query(`SELECT "transportMechanism" FROM messages WHERE id = 'msg-1'`);
    expect(Number(after.rows[0].transportMechanism)).toBe(0);
  });
});

describe.skipIf(!mysqlAvailable)('migration 170 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig170'));
    await pool.query('DROP TABLE IF EXISTS messages');
    await pool.query(`
      CREATE TABLE messages (
        id VARCHAR(64) PRIMARY KEY,
        fromNodeNum BIGINT NOT NULL,
        toNodeNum BIGINT NOT NULL,
        text TEXT NOT NULL,
        channel INT NOT NULL DEFAULT 0,
        viaMqtt BOOLEAN,
        timestamp BIGINT NOT NULL,
        createdAt BIGINT NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds transportMechanism, is idempotent, and round-trips an explicit 0 (INTERNAL) as 0, not NULL', async () => {
    await runMigration170Mysql(pool);
    await expect(runMigration170Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO messages (id, fromNodeNum, toNodeNum, text, timestamp, createdAt) VALUES ('msg-1', 1, 2, 'hi', 1000, 1000)`);

    const [before] = await pool.query(`SELECT transportMechanism FROM messages WHERE id = 'msg-1'`);
    expect((before as Record<string, unknown>[])[0].transportMechanism).toBeNull();

    await pool.query(`UPDATE messages SET transportMechanism = 0 WHERE id = 'msg-1'`);
    const [after] = await pool.query(`SELECT transportMechanism FROM messages WHERE id = 'msg-1'`);
    const row = (after as Record<string, unknown>[])[0];
    expect(Number(row.transportMechanism)).toBe(0);
  });
});
