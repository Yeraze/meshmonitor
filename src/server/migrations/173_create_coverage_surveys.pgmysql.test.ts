/**
 * Migration 173 — PostgreSQL / MySQL container behaviour (#5277 Phase 4b WP1).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates the table
 * against the live test containers (localhost:5433 / :3307), each in its OWN
 * isolated database (`createIsolatedPostgresDatabase`/`createIsolatedMysqlDatabase`),
 * asserts idempotency and a UUID text PK round-trip. A silent skip here still
 * reports `success: true` at the suite level — confirm via `numPendingTests`
 * in the JSON reporter, not just the pass/fail summary (see CLAUDE.md
 * Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration173Postgres, runMigration173Mysql } from './173_create_coverage_surveys.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 173 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig173'));
    await pool.query('DROP TABLE IF EXISTS coverage_surveys CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration173Postgres(client1);
      await expect(runMigration173Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    const id1 = randomUUID();
    const id2 = randomUUID();
    await pool.query(
      `INSERT INTO coverage_surveys (id, name, "senderId", "startAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id1, 'Drive 1', '!aaaaaaaa', now, now, now],
    );
    await pool.query(
      `INSERT INTO coverage_surveys (id, name, "senderId", "startAt", "endAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id2, 'Drive 2', '!aaaaaaaa', now + 1000, now + 5000, now, now],
    );

    const { rows } = await pool.query(
      `SELECT id, name, "endAt" FROM coverage_surveys ORDER BY "startAt" ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(id1);
    expect(rows[0].endAt).toBeNull();
    expect(rows[1].id).toBe(id2);
    expect(Number(rows[1].endAt)).toBe(now + 5000);

    // Duplicate id (TEXT PRIMARY KEY) is rejected.
    await expect(
      pool.query(
        `INSERT INTO coverage_surveys (id, name, "senderId", "startAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id1, 'Duplicate', '!bbbbbbbb', now + 2000, now, now],
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 173 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig173'));
    await pool.query('DROP TABLE IF EXISTS coverage_surveys');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    await runMigration173Mysql(pool);
    await expect(runMigration173Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    const id1 = randomUUID();
    const id2 = randomUUID();
    await pool.query(
      `INSERT INTO coverage_surveys (id, name, senderId, startAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id1, 'Drive 1', '!aaaaaaaa', now, now, now],
    );
    await pool.query(
      `INSERT INTO coverage_surveys (id, name, senderId, startAt, endAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id2, 'Drive 2', '!aaaaaaaa', now + 1000, now + 5000, now, now],
    );

    const [rows] = await pool.query(
      `SELECT id, name, endAt FROM coverage_surveys ORDER BY startAt ASC`,
    );
    const result = rows as any[];
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(id1);
    expect(result[0].endAt).toBeNull();
    expect(result[1].id).toBe(id2);
    expect(Number(result[1].endAt)).toBe(now + 5000);

    // Duplicate id (VARCHAR(36) PRIMARY KEY) is rejected.
    await expect(
      pool.query(
        `INSERT INTO coverage_surveys (id, name, senderId, startAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id1, 'Duplicate', '!bbbbbbbb', now + 2000, now, now],
      ),
    ).rejects.toThrow();
  });
});
