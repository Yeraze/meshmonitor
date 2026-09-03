/**
 * Migration 152 — PostgreSQL / MySQL container behaviour (#4816 Phase 4
 * WP1).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates the table
 * against the live test containers (localhost:5433 / :3307), asserts
 * idempotency, the unique constraint on (sourceId, messageId, relayByte),
 * and round-trips a fractional-SNR row on each backend. A silent skip here
 * still reports `success: true` at the suite level — confirm via
 * `numPendingTests` in the JSON reporter, not just the pass/fail summary
 * (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration152Postgres, runMigration152Mysql } from './152_create_meshtastic_heard_repeaters.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 152 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig152'));
    await pool.query('DROP TABLE IF EXISTS meshtastic_heard_repeaters CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration152Postgres(client1);
      await expect(runMigration152Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO meshtastic_heard_repeaters
        ("sourceId", "messageId", "relayByte", snr, "heardAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      ['src-1', 'msg-1', 0xa3, -7.25, now],
    );
    await pool.query(
      `INSERT INTO meshtastic_heard_repeaters
        ("sourceId", "messageId", "relayByte", snr, "heardAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $5)`,
      ['src-1', 'msg-1', 0x7f, -3.5, now + 1000],
    );

    const { rows } = await pool.query(
      `SELECT "relayByte", snr, "heardAt" FROM meshtastic_heard_repeaters
       WHERE "sourceId" = $1 AND "messageId" = $2 ORDER BY "relayByte" ASC`,
      ['src-1', 'msg-1'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].relayByte).toBe(0x7f);
    expect(Number(rows[0].snr)).toBeCloseTo(-3.5);
    expect(rows[1].relayByte).toBe(0xa3);
    expect(Number(rows[1].snr)).toBeCloseTo(-7.25);

    // Unique constraint on (sourceId, messageId, relayByte).
    await expect(
      pool.query(
        `INSERT INTO meshtastic_heard_repeaters
          ("sourceId", "messageId", "relayByte", snr, "heardAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $5)`,
        ['src-1', 'msg-1', 0xa3, -1, now + 2000],
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 152 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig152'));
    await pool.query('DROP TABLE IF EXISTS meshtastic_heard_repeaters');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    await runMigration152Mysql(pool);
    await expect(runMigration152Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO meshtastic_heard_repeaters
        (sourceId, messageId, relayByte, snr, heardAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['src-1', 'msg-1', 0xa3, -7.25, now, now],
    );
    await pool.query(
      `INSERT INTO meshtastic_heard_repeaters
        (sourceId, messageId, relayByte, snr, heardAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['src-1', 'msg-1', 0x7f, -3.5, now + 1000, now + 1000],
    );

    const [rows] = await pool.query(
      `SELECT relayByte, snr, heardAt FROM meshtastic_heard_repeaters
       WHERE sourceId = ? AND messageId = ? ORDER BY relayByte ASC`,
      ['src-1', 'msg-1'],
    );
    const result = rows as any[];
    expect(result).toHaveLength(2);
    expect(result[0].relayByte).toBe(0x7f);
    expect(Number(result[0].snr)).toBeCloseTo(-3.5);
    expect(result[1].relayByte).toBe(0xa3);
    expect(Number(result[1].snr)).toBeCloseTo(-7.25);

    // Unique constraint on (sourceId, messageId, relayByte).
    await expect(
      pool.query(
        `INSERT INTO meshtastic_heard_repeaters
          (sourceId, messageId, relayByte, snr, heardAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['src-1', 'msg-1', 0xa3, -1, now + 2000, now + 2000],
      ),
    ).rejects.toThrow();
  });
});
