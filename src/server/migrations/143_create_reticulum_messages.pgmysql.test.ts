/**
 * Migration 143 — PostgreSQL / MySQL container behaviour.
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — runs the real
 * migration functions against the live test containers (localhost:5433 /
 * :3307) and asserts table/index creation + idempotency on each backend.
 * A silent skip here still reports `success: true` at the suite level —
 * confirm via `numPendingTests` in the JSON reporter, not just the
 * pass/fail summary (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration143Postgres, runMigration143Mysql } from './143_create_reticulum_messages.js';
import { postgresAvailable, mysqlAvailable } from '../../db/repositories/test-utils.js';

const { Pool: PgPool } = pg;

describe.skipIf(!postgresAvailable)('migration 143 — PostgreSQL (container)', () => {
  let pool: InstanceType<typeof PgPool>;

  beforeAll(async () => {
    pool = new PgPool({
      host: 'localhost',
      port: 5433,
      user: 'test',
      password: 'test',
      database: 'meshmonitor_test',
    });
    await pool.query('DROP TABLE IF EXISTS reticulum_messages CASCADE');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + indexes and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration143Postgres(client1);
      await expect(runMigration143Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    const id = `src-1_${'c'.repeat(32)}`;
    await pool.query(
      `INSERT INTO reticulum_messages
        (id, "sourceId", "fromHash", "toHash", title, content, "timestamp", "receivedAt", "createdAt",
         state, method, "signatureValidated", ratcheted, fields, "replyToHash", "threadHash", rssi, snr, quality)
       VALUES ($1, 'src-1', $2, $3, 'hi', 'hello world', $4, $4, $4, 'delivered', 'direct', true, false,
         '{"attachments":[]}', NULL, 'thread-1', -70, 3.25, 80)`,
      [id, 'f'.repeat(32), 't'.repeat(32), now],
    );

    // Duplicate id violates the primary key.
    await expect(
      pool.query(
        `INSERT INTO reticulum_messages (id, "sourceId", "fromHash", "toHash", "timestamp", "createdAt", state)
         VALUES ($1, 'src-1', $2, $3, $4, $4, 'delivered')`,
        [id, 'f'.repeat(32), 't'.repeat(32), now],
      ),
    ).rejects.toThrow();

    const { rows } = await pool.query(
      `SELECT rssi, snr, quality, "signatureValidated", "threadHash" FROM reticulum_messages WHERE id = $1`,
      [id],
    );
    expect(rows[0].rssi).toBe(-70);
    expect(Number(rows[0].snr)).toBeCloseTo(3.25);
    expect(rows[0].quality).toBe(80);
    expect(rows[0].signatureValidated).toBe(true);
    expect(rows[0].threadHash).toBe('thread-1');
  });
});

describe.skipIf(!mysqlAvailable)('migration 143 — MySQL (container)', () => {
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
    await pool.query('DROP TABLE IF EXISTS reticulum_messages');
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('creates the table + indexes and is idempotent', async () => {
    await runMigration143Mysql(pool);
    await expect(runMigration143Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    const id = `src-1_${'d'.repeat(32)}`;
    await pool.query(
      `INSERT INTO reticulum_messages
        (id, sourceId, fromHash, toHash, title, content, timestamp, receivedAt, createdAt,
         state, method, signatureValidated, ratcheted, fields, replyToHash, threadHash, rssi, snr, quality)
       VALUES (?, 'src-1', ?, ?, 'hi', 'hello world', ?, ?, ?, 'delivered', 'direct', 1, 0,
         '{"attachments":[]}', NULL, 'thread-1', -70, 3.25, 80)`,
      [id, 'f'.repeat(32), 't'.repeat(32), now, now, now],
    );

    // Duplicate id violates the primary key.
    await expect(
      pool.query(
        `INSERT INTO reticulum_messages (id, sourceId, fromHash, toHash, timestamp, createdAt, state)
         VALUES (?, 'src-1', ?, ?, ?, ?, 'delivered')`,
        [id, 'f'.repeat(32), 't'.repeat(32), now, now],
      ),
    ).rejects.toThrow();

    const [rows] = await pool.query(
      `SELECT rssi, snr, quality, signatureValidated, threadHash FROM reticulum_messages WHERE id = ?`,
      [id],
    );
    const row = (rows as any[])[0];
    expect(row.rssi).toBe(-70);
    expect(Number(row.snr)).toBeCloseTo(3.25);
    expect(row.quality).toBe(80);
    expect(row.signatureValidated).toBe(1);
    expect(row.threadHash).toBe('thread-1');
  });
});
