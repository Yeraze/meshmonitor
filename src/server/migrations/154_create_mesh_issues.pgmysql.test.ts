/**
 * Migration 154 — PostgreSQL / MySQL container behaviour (Mesh Issues
 * Analysis epic #4964, Phase 1 WP1).
 *
 * `describe.skipIf(!postgresAvailable/!mysqlAvailable)` — creates the table
 * against the live test containers (localhost:5433 / :3307), asserts
 * idempotency and the unique constraint on (issueType, subjectKey) on each
 * backend. A silent skip here still reports `success: true` at the suite
 * level — confirm via `numPendingTests` in the JSON reporter, not just the
 * pass/fail summary (see CLAUDE.md Multi-Database section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { runMigration154Postgres, runMigration154Mysql } from './154_create_mesh_issues.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

describe.skipIf(!postgresAvailable)('migration 154 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig154'));
    await pool.query('DROP TABLE IF EXISTS mesh_issues CASCADE');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    const client1 = await pool.connect();
    try {
      await runMigration154Postgres(client1);
      await expect(runMigration154Postgres(client1)).resolves.toBeUndefined();
    } finally {
      client1.release();
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO mesh_issues
        ("issueType", "subjectKey", "nodeNum", severity, confidence, evidence, "sourceIds",
         "firstDetected", "lastDetected", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)`,
      ['A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now],
    );

    const { rows } = await pool.query(
      `SELECT "issueType", "subjectKey", "nodeNum", status, "cleanRuns", dismissed
       FROM mesh_issues WHERE "subjectKey" = $1`,
      ['node:123'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(Number(rows[0].cleanRuns)).toBe(0);
    expect(rows[0].dismissed).toBe(false);
    expect(Number(rows[0].nodeNum)).toBe(123);

    // Unique constraint on (issueType, subjectKey).
    await expect(
      pool.query(
        `INSERT INTO mesh_issues
          ("issueType", "subjectKey", "nodeNum", severity, confidence, evidence, "sourceIds",
           "firstDetected", "lastDetected", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)`,
        ['A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now + 1000],
      ),
    ).rejects.toThrow();

    // A null nodeNum (area finding) must be accepted.
    await pool.query(
      `INSERT INTO mesh_issues
        ("issueType", "subjectKey", "nodeNum", severity, confidence, evidence, "sourceIds",
         "firstDetected", "lastDetected", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)`,
      ['A2b_congested_area', 'area:700:-1220', null, 'warning', 'medium', '{}', '[]', now],
    );
    const areaRow = await pool.query(
      `SELECT "nodeNum" FROM mesh_issues WHERE "subjectKey" = $1`,
      ['area:700:-1220'],
    );
    expect(areaRow.rows[0].nodeNum).toBeNull();
  });
});

describe.skipIf(!mysqlAvailable)('migration 154 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig154'));
    await pool.query('DROP TABLE IF EXISTS mesh_issues');
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table + indexes and is idempotent', async () => {
    await runMigration154Mysql(pool);
    await expect(runMigration154Mysql(pool)).resolves.toBeUndefined();

    const now = Date.now();
    await pool.query(
      `INSERT INTO mesh_issues
        (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
         firstDetected, lastDetected, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now, now, now, now],
    );

    const [rows] = await pool.query(
      `SELECT issueType, subjectKey, nodeNum, status, cleanRuns, dismissed
       FROM mesh_issues WHERE subjectKey = ?`,
      ['node:123'],
    );
    const result = rows as any[];
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('open');
    expect(Number(result[0].cleanRuns)).toBe(0);
    expect(Number(result[0].dismissed)).toBe(0);
    expect(Number(result[0].nodeNum)).toBe(123);

    // Unique constraint on (issueType, subjectKey).
    await expect(
      pool.query(
        `INSERT INTO mesh_issues
          (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
           firstDetected, lastDetected, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['A1_deprecated_role', 'node:123', 123, 'warning', 'high', '{}', '[]', now + 1000, now + 1000, now + 1000, now + 1000],
      ),
    ).rejects.toThrow();

    // A null nodeNum (area finding) must be accepted.
    await pool.query(
      `INSERT INTO mesh_issues
        (issueType, subjectKey, nodeNum, severity, confidence, evidence, sourceIds,
         firstDetected, lastDetected, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['A2b_congested_area', 'area:700:-1220', null, 'warning', 'medium', '{}', '[]', now, now, now, now],
    );
    const [areaRows] = await pool.query(
      `SELECT nodeNum FROM mesh_issues WHERE subjectKey = ?`,
      ['area:700:-1220'],
    );
    expect((areaRows as any[])[0].nodeNum).toBeNull();
  });
});
