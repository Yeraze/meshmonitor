/**
 * Migration 151 — PostgreSQL / MySQL container behaviour (#4816 Phase 3 WP1).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates the table
 * against the live test containers (localhost:5433 / :3307), asserts
 * idempotency, and round-trips a row on each backend. A silent skip here
 * still reports `success: true` at the suite level — confirm via
 * `numPendingTests` in the JSON reporter, not just the pass/fail summary
 * (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration151Postgres, runMigration151Mysql } from './151_create_message_events.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

describe.skipIf(!postgresAvailable)('migration 151 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
    await pool.query('DROP TABLE IF EXISTS message_events CASCADE');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + index and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration151Postgres(client1);
      await expect(runMigration151Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO message_events
        ("sourceId", "messageId", "eventType", provenance, detail, "timestamp", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      ['src-1', 'msg-1', 'submitted', 'reported', null, now],
    );
    await pool.query(
      `INSERT INTO message_events
        ("sourceId", "messageId", "eventType", provenance, detail, "timestamp", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      ['src-1', 'msg-1', 'delivered', 'reported', '{"roundTripMs":250}', now + 1000],
    );

    const { rows } = await pool.query(
      `SELECT "eventType", detail, "timestamp" FROM message_events
       WHERE "sourceId" = $1 AND "messageId" = $2 ORDER BY "timestamp" ASC`,
      ['src-1', 'msg-1'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].eventType).toBe('submitted');
    expect(rows[0].detail).toBeNull();
    expect(rows[1].eventType).toBe('delivered');
    expect(rows[1].detail).toBe('{"roundTripMs":250}');
  });
});

describe.skipIf(!mysqlAvailable)('migration 151 — MySQL (container)', () => {
  let pool: mysql.Pool;

  beforeAll(async () => {
    pool = mysql.createPool({
      host: 'localhost',
      port: 3307,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
      connectionLimit: 5,
    });
    await pool.query('DROP TABLE IF EXISTS message_events');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + index and is idempotent', async () => {
    await runMigration151Mysql(pool);
    await expect(runMigration151Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO message_events
        (sourceId, messageId, eventType, provenance, detail, timestamp, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['src-1', 'msg-1', 'submitted', 'reported', null, now, now],
    );
    await pool.query(
      `INSERT INTO message_events
        (sourceId, messageId, eventType, provenance, detail, timestamp, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['src-1', 'msg-1', 'delivered', 'reported', '{"roundTripMs":250}', now + 1000, now + 1000],
    );

    const [rows] = await pool.query(
      `SELECT eventType, detail, timestamp FROM message_events
       WHERE sourceId = ? AND messageId = ? ORDER BY timestamp ASC`,
      ['src-1', 'msg-1'],
    );
    const result = rows as any[];
    expect(result).toHaveLength(2);
    expect(result[0].eventType).toBe('submitted');
    expect(result[0].detail).toBeNull();
    expect(result[1].eventType).toBe('delivered');
    expect(result[1].detail).toBe('{"roundTripMs":250}');
  });
});
