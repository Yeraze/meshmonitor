/**
 * Migration 249 (#5891 P3): `coverage_imports` + `coverage_receptions.importId`
 * on SQLite, PostgreSQL and MySQL. PG/MySQL blocks use isolated databases and
 * skip when no container listens, so confirm coverage via `numPendingTests`.
 * Each backend creates `coverage_receptions` with migration 172 first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { migration as migration172, runMigration172Postgres, runMigration172Mysql } from './172_create_coverage_receptions.js';
import { migration, runMigration249Postgres, runMigration249Mysql } from './249_create_coverage_imports.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

const IMPORT_COLUMNS = [
  'id', 'sourceId', 'kind', 'format', 'filename', 'fileSha256', 'status', 'importedBy', 'importedAt',
  'rowCount', 'insertedCount', 'duplicateCount', 'skippedCount', 'firstReceivedAt', 'lastReceivedAt',
  'sourceTruncated',
];
const INDEXES = ['cov_imp_source_sha_uniq', 'cov_imp_source_imported_idx', 'cov_rx_import_idx'];

describe('Migration 249 — SQLite', () => {
  it('creates the table, column and indexes; re-run keeps rows', () => {
    const db = new Database(':memory:');
    migration172.up(db);
    db.exec(
      `INSERT INTO coverage_receptions (sourceId, protocol, receiverKind, receiverId, senderId, packetKey, pathKey, latitude, longitude, receivedAt)
       VALUES ('src','meshtastic','local','!aaaaaaaa','!bbbbbbbb','1','r0:h0',1,2,1)`,
    );
    migration.up(db);
    db.exec(
      `INSERT INTO coverage_imports (id, sourceId, kind, format, filename, fileSha256, status, importedAt, rowCount, insertedCount, duplicateCount, skippedCount)
       VALUES ('i1','src','coverage_report','csv','a.csv','abc','complete',1,1,1,0,0)`,
    );
    db.exec(`UPDATE coverage_receptions SET importId = 'i1'`);
    migration.up(db);

    const cols = (db.prepare(`PRAGMA table_info(coverage_imports)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(IMPORT_COLUMNS);
    const rxCols = (db.prepare(`PRAGMA table_info(coverage_receptions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(rxCols).toContain('importId');
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(INDEXES));
    const partial = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'cov_rx_import_idx'`).get() as { sql: string };
    expect(partial.sql).toMatch(/WHERE importId IS NOT NULL/);

    expect((db.prepare(`SELECT COUNT(*) AS n FROM coverage_imports`).get() as { n: number }).n).toBe(1);
    expect((db.prepare(`SELECT importId FROM coverage_receptions`).get() as { importId: string }).importId).toBe('i1');
    expect((db.prepare(`SELECT sourceTruncated FROM coverage_imports`).get() as { sourceTruncated: number }).sourceTruncated).toBe(0);

    // Unique (sourceId, fileSha256).
    expect(() =>
      db.exec(
        `INSERT INTO coverage_imports (id, sourceId, kind, format, filename, fileSha256, status, importedAt, rowCount, insertedCount, duplicateCount, skippedCount)
         VALUES ('i2','src','coverage_report','csv','b.csv','abc','complete',2,1,1,0,0)`,
      ),
    ).toThrow();
    db.close();
  });
});

describe.skipIf(!postgresAvailable)('Migration 249 — PostgreSQL (container)', () => {
  let pool: pg.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedPostgresDatabase('mig249'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table, column and indexes and is idempotent', async () => {
    const client = await pool.connect();
    try {
      await runMigration172Postgres(client);
      await runMigration249Postgres(client);
      await pool.query(
        `INSERT INTO coverage_imports ("id","sourceId","kind","format","filename","fileSha256","status","importedAt","rowCount","insertedCount","duplicateCount","skippedCount")
         VALUES ('i1','src','coverage_report','csv','a.csv','abc','complete',1,1,1,0,0)`,
      );
      await runMigration249Postgres(client);
    } finally {
      client.release();
    }
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'coverage_imports' ORDER BY ordinal_position`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(IMPORT_COLUMNS);
    const rx = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'coverage_receptions' AND column_name = 'importId'`,
    );
    expect(rx.rows).toHaveLength(1);
    const i = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`);
    expect(i.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(INDEXES));
    expect(i.rows.find((r) => r.indexname === 'cov_rx_import_idx').indexdef).toMatch(/WHERE \("importId" IS NOT NULL\)/);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM coverage_imports`)).rows[0].n).toBe(1);
    await expect(
      pool.query(
        `INSERT INTO coverage_imports ("id","sourceId","kind","format","filename","fileSha256","status","importedAt","rowCount","insertedCount","duplicateCount","skippedCount")
         VALUES ('i2','src','coverage_report','csv','b.csv','abc','complete',2,1,1,0,0)`,
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!mysqlAvailable)('Migration 249 — MySQL (container)', () => {
  let pool: mysql.Pool;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, cleanup } = await createIsolatedMysqlDatabase('mig249'));
  });
  afterAll(async () => {
    await cleanup?.();
  });

  it('creates the table, column and indexes and is idempotent', async () => {
    await runMigration172Mysql(pool);
    await runMigration249Mysql(pool);
    await pool.query(
      `INSERT INTO coverage_imports (id, sourceId, kind, format, filename, fileSha256, status, importedAt, rowCount, insertedCount, duplicateCount, skippedCount)
       VALUES ('i1','src','coverage_report','csv','a.csv','abc','complete',1,1,1,0,0)`,
    );
    await runMigration249Mysql(pool);

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coverage_imports' ORDER BY ORDINAL_POSITION`,
    );
    expect((cols as Array<{ n: string }>).map((r) => r.n)).toEqual(IMPORT_COLUMNS);
    const [rx] = await pool.query(
      `SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'coverage_receptions' AND COLUMN_NAME = 'importId'`,
    );
    expect(rx as unknown[]).toHaveLength(1);
    const [i] = await pool.query(`SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`);
    expect((i as Array<{ n: string }>).map((r) => r.n)).toEqual(expect.arrayContaining(INDEXES));
    const [c] = await pool.query(`SELECT COUNT(*) AS n FROM coverage_imports`);
    expect(Number((c as Array<{ n: unknown }>)[0].n)).toBe(1);
    await expect(
      pool.query(
        `INSERT INTO coverage_imports (id, sourceId, kind, format, filename, fileSha256, status, importedAt, rowCount, insertedCount, duplicateCount, skippedCount)
         VALUES ('i2','src','coverage_report','csv','b.csv','abc','complete',2,1,1,0,0)`,
      ),
    ).rejects.toThrow();
  });
});
