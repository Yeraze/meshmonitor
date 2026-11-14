/**
 * Migration 233 — PostgreSQL / MySQL container behaviour (#6210).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)`: each backend runs in
 * its OWN isolated database. A silent skip still reports success, so confirm
 * coverage via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import { runMigration233Postgres, runMigration233Mysql } from './233_create_direct_rf_contacts.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 233 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig233'));
  });
  afterAll(async () => { await cleanup?.(); });

  it('creates the table + unique key and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration233Postgres(client);
      await expect(runMigration233Postgres(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
    const insert = `INSERT INTO direct_rf_contacts ("sourceId", protocol, "nodeKey", "nodeNum", "dayBucket", "firstHeardAt", "lastHeardAt")
                    VALUES ($1, 'meshtastic', $2, $3, $4, $5, $6)`;
    // nodeNum above the signed 32-bit range must fit (BIGINT).
    await pool.query(insert, ['src-a', '!ffffffff', 0xffffffff, 86_400_000, 86_400_001, 86_400_002]);
    await expect(pool.query(insert, ['src-a', '!ffffffff', 0xffffffff, 86_400_000, 86_400_001, 86_400_002])).rejects.toThrow();
    const { rows } = await pool.query(`SELECT "nodeNum", "receptionCount", "snrSum" FROM direct_rf_contacts`);
    expect(Number(rows[0].nodeNum)).toBe(0xffffffff);
    expect(Number(rows[0].receptionCount)).toBe(0);
    expect(Number(rows[0].snrSum)).toBe(0);
  });
});

describe.skipIf(!mysqlAvailable)('migration 233 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig233'));
  });
  afterAll(async () => { await cleanup?.(); });

  it('creates the table + unique key and is idempotent', async () => {
    await runMigration233Mysql(pool);
    await expect(runMigration233Mysql(pool)).resolves.toBeUndefined();
    const insert = `INSERT INTO direct_rf_contacts (sourceId, protocol, nodeKey, nodeNum, dayBucket, firstHeardAt, lastHeardAt)
                    VALUES (?, 'meshtastic', ?, ?, ?, ?, ?)`;
    await pool.query(insert, ['src-a', '!ffffffff', 0xffffffff, 86_400_000, 86_400_001, 86_400_002]);
    await expect(pool.query(insert, ['src-a', '!ffffffff', 0xffffffff, 86_400_000, 86_400_001, 86_400_002])).rejects.toThrow();
    const [rows] = await pool.query(`SELECT nodeNum, receptionCount FROM direct_rf_contacts`) as unknown as [Array<Record<string, unknown>>];
    expect(Number(rows[0].nodeNum)).toBe(0xffffffff);
    expect(Number(rows[0].receptionCount)).toBe(0);
  });
});
