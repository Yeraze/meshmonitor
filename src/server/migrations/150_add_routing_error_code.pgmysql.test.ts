/**
 * Migration 150 — PostgreSQL / MySQL container behaviour (#4816 Phase 2).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates a minimal
 * `messages` table (the columns this migration touches only) against the
 * live test containers (localhost:5433 / :3307), then runs the real
 * migration 150 functions and asserts column presence + idempotency + a
 * round-tripped failed-delivery code on each backend. A silent skip here
 * still reports `success: true` at the suite level — confirm via
 * `numPendingTests` in the JSON reporter, not just the pass/fail summary
 * (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration150Postgres, runMigration150Mysql } from './150_add_routing_error_code.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 150 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig150'));
    await pool.query('DROP TABLE IF EXISTS messages CASCADE');
    await pool.query(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        "requestId" BIGINT,
        "deliveryState" TEXT
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds routingErrorCode to an existing table, is idempotent, and round-trips a failed-delivery code', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration150Postgres(client1);
      await expect(runMigration150Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    await pool.query(`INSERT INTO messages (id, "requestId", "deliveryState") VALUES ('msg-1', 42, 'sent')`);

    const before = await pool.query(`SELECT "routingErrorCode" FROM messages WHERE id = 'msg-1'`);
    expect(before.rows[0].routingErrorCode).toBeNull();

    await pool.query(`UPDATE messages SET "deliveryState" = 'failed', "routingErrorCode" = 5 WHERE id = 'msg-1'`);
    const after = await pool.query(`SELECT "routingErrorCode", "deliveryState" FROM messages WHERE id = 'msg-1'`);
    expect(Number(after.rows[0].routingErrorCode)).toBe(5);
    expect(after.rows[0].deliveryState).toBe('failed');
  });
});

describe.skipIf(!mysqlAvailable)('migration 150 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig150'));
    await pool.query('DROP TABLE IF EXISTS messages');
    await pool.query(`
      CREATE TABLE messages (
        id VARCHAR(64) PRIMARY KEY,
        requestId BIGINT,
        deliveryState VARCHAR(32)
      )
    `);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('adds routingErrorCode to an existing table, is idempotent, and round-trips a failed-delivery code', async () => {
    await runMigration150Mysql(pool);
    await expect(runMigration150Mysql(pool)).resolves.toBeUndefined();

    await pool.query(`INSERT INTO messages (id, requestId, deliveryState) VALUES ('msg-1', 42, 'sent')`);

    const [before] = await pool.query(`SELECT routingErrorCode FROM messages WHERE id = 'msg-1'`);
    expect((before as any[])[0].routingErrorCode).toBeNull();

    await pool.query(`UPDATE messages SET deliveryState = 'failed', routingErrorCode = 5 WHERE id = 'msg-1'`);
    const [after] = await pool.query(`SELECT routingErrorCode, deliveryState FROM messages WHERE id = 'msg-1'`);
    const row = (after as any[])[0];
    expect(Number(row.routingErrorCode)).toBe(5);
    expect(row.deliveryState).toBe('failed');
  });
});
