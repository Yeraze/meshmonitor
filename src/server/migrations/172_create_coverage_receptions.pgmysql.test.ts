/**
 * Migration 172 — PostgreSQL / MySQL container behaviour (#5277 Phase 1 WP1).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates the table
 * against the live test containers (localhost:5433 / :3307), each in its OWN
 * isolated database (`createIsolatedPostgresDatabase`/`createIsolatedMysqlDatabase`),
 * asserts idempotency and the 5-column unique constraint. A silent skip here
 * still reports `success: true` at the suite level — confirm via
 * `numPendingTests` in the JSON reporter, not just the pass/fail summary
 * (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration172Postgres, runMigration172Mysql } from './172_create_coverage_receptions.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 172 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig172'));
    await pool.query('DROP TABLE IF EXISTS coverage_receptions CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration172Postgres(client1);
      await expect(runMigration172Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO coverage_receptions
        ("sourceId", protocol, "receiverKind", "receiverId", "senderId", "packetKey", "pathKey", latitude, longitude, "receivedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r0:h0', 12.5, -45.25, now],
    );
    await pool.query(
      `INSERT INTO coverage_receptions
        ("sourceId", protocol, "receiverKind", "receiverId", "senderId", "packetKey", "pathKey", latitude, longitude, "receivedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r5:h1', 12.5, -45.25, now + 1000],
    );

    const { rows } = await pool.query(
      `SELECT "pathKey" FROM coverage_receptions WHERE "sourceId" = $1 ORDER BY "receivedAt" ASC`,
      ['src-1'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].pathKey).toBe('r0:h0');
    expect(rows[1].pathKey).toBe('r5:h1');

    // Unique constraint on (sourceId, receiverId, senderId, packetKey, pathKey).
    await expect(
      pool.query(
        `INSERT INTO coverage_receptions
          ("sourceId", protocol, "receiverKind", "receiverId", "senderId", "packetKey", "pathKey", latitude, longitude, "receivedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r0:h0', 12.5, -45.25, now + 2000],
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('migration 172 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig172'));
    await pool.query('DROP TABLE IF EXISTS coverage_receptions');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    await runMigration172Mysql(pool);
    await expect(runMigration172Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO coverage_receptions
        (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r0:h0', 12.5, -45.25, now],
    );
    await pool.query(
      `INSERT INTO coverage_receptions
        (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r5:h1', 12.5, -45.25, now + 1000],
    );

    const [rows] = await pool.query(
      `SELECT pathKey FROM coverage_receptions WHERE sourceId = ? ORDER BY receivedAt ASC`,
      ['src-1'],
    );
    const result = rows as any[];
    expect(result).toHaveLength(2);
    expect(result[0].pathKey).toBe('r0:h0');
    expect(result[1].pathKey).toBe('r5:h1');

    // Unique constraint on (sourceId, receiverId, senderId, packetKey, pathKey).
    await expect(
      pool.query(
        `INSERT INTO coverage_receptions
          (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['src-1', 'meshtastic', 'local', '!aaaaaaaa', '!bbbbbbbb', '100', 'r0:h0', 12.5, -45.25, now + 2000],
      ),
    ).rejects.toThrow();
  });
});
