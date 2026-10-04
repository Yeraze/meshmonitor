/**
 * Restore of `meshcore_observer_keys` on real PostgreSQL and MySQL (#5596).
 *
 * The SQLite round trip is covered end to end in
 * systemBackupRestore.observerKeys.test.ts. This file proves the same table
 * survives the PostgreSQL and MySQL restore paths, which build their own
 * INSERT statements: the table's columns are camelCase (quoted on PostgreSQL)
 * and its timestamps are BIGINT.
 *
 * The table is created by the real migration (133), the backup rows are read
 * back with the same `SELECT *` the backup service runs, and each suite owns a
 * private database. Both suites skip silently when the containers are down, so
 * confirm coverage via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';
import {
  runMigration133Postgres,
  runMigration133Mysql,
} from '../migrations/133_add_meshcore_observer_keys.js';

// The restore paths under test open their own pool from a URL; they never
// touch the app's DatabaseService.
vi.mock('../../services/database.js', () => ({ default: {} }));

import { systemRestoreService } from './systemRestoreService.js';

const TABLE = 'meshcore_observer_keys';

const envelope = (tag: string) =>
  JSON.stringify({ v: 1, kid: 'deadbeef', iv: tag.repeat(12), ct: tag.repeat(64), tag: tag.repeat(16) });

const BACKED_UP = [
  {
    sourceId: 'restore-keys-a',
    encryptedPrivateKey: envelope('a1'),
    publicKey: 'AA'.repeat(32),
    keyOrigin: 'device',
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_500,
  },
  {
    sourceId: 'restore-keys-b',
    encryptedPrivateKey: envelope('b2'),
    publicKey: 'BB'.repeat(32),
    keyOrigin: 'manual',
    createdAt: 1_790_000_001_000,
    updatedAt: 1_790_000_001_500,
  },
];

/** BIGINT comes back as a string from pg; compare as the backup service writes it. */
const normalise = (rows: Array<Record<string, unknown>>) =>
  rows
    .map((r) => ({ ...r, createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt) }))
    .sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));

type Restore = (p: string, t: string[], u: string) => Promise<{ rowsRestored: number; tablesRestored: number }>;

describe.skipIf(!postgresAvailable)('restorePostgres — meshcore_observer_keys (container, #5596)', () => {
  let pool: pg.Pool;
  let databaseName: string;
  let cleanup: (() => Promise<void>) | undefined;
  let backupDir: string;

  beforeAll(async () => {
    ({ pool, databaseName, cleanup } = await createIsolatedPostgresDatabase('restoreobskeys'));
    await runMigration133Postgres(pool);

    // Write the rows, then read them back the way the backup service exports
    // a table — that read is what lands in the backup file.
    for (const r of BACKED_UP) {
      await pool.query(
        `INSERT INTO ${TABLE} ("sourceId", "encryptedPrivateKey", "publicKey", "keyOrigin", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [r.sourceId, r.encryptedPrivateKey, r.publicKey, r.keyOrigin, r.createdAt, r.updatedAt],
      );
    }
    const exported = await pool.query(`SELECT * FROM "${TABLE}"`);
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-restore-obskeys-pg-'));
    fs.writeFileSync(path.join(backupDir, `${TABLE}.json`), JSON.stringify(normalise(exported.rows)));

    // Drift after the backup: one key lost, one replaced, one new.
    await pool.query(`DELETE FROM ${TABLE} WHERE "sourceId" = 'restore-keys-a'`);
    await pool.query(`UPDATE ${TABLE} SET "encryptedPrivateKey" = 'replaced' WHERE "sourceId" = 'restore-keys-b'`);
    await pool.query(
      `INSERT INTO ${TABLE} ("sourceId", "encryptedPrivateKey", "createdAt", "updatedAt") VALUES ('made-later', 'x', 1, 1)`,
    );
  });

  afterAll(async () => {
    if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
    await cleanup?.();
  });

  it('restores every key row exactly, replacing what was there', async () => {
    const url = `postgres://test:test@localhost:5433/${databaseName}`;
    const result = await (systemRestoreService as unknown as { restorePostgres: Restore }).restorePostgres(
      backupDir,
      [TABLE],
      url,
    );
    expect(result).toEqual({ rowsRestored: 2, tablesRestored: 1 });

    const { rows } = await pool.query(`SELECT * FROM "${TABLE}"`);
    expect(normalise(rows)).toEqual(BACKED_UP);
  });
});

describe.skipIf(!mysqlAvailable)('restoreMySQL — meshcore_observer_keys (container, #5596)', () => {
  let pool: mysql.Pool;
  let databaseName: string;
  let cleanup: (() => Promise<void>) | undefined;
  let backupDir: string;

  beforeAll(async () => {
    ({ pool, databaseName, cleanup } = await createIsolatedMysqlDatabase('restoreobskeys'));
    await runMigration133Mysql(pool);

    for (const r of BACKED_UP) {
      await pool.query(
        `INSERT INTO ${TABLE} (sourceId, encryptedPrivateKey, publicKey, keyOrigin, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.sourceId, r.encryptedPrivateKey, r.publicKey, r.keyOrigin, r.createdAt, r.updatedAt],
      );
    }
    const [exported] = await pool.query(`SELECT * FROM \`${TABLE}\``);
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-restore-obskeys-my-'));
    fs.writeFileSync(
      path.join(backupDir, `${TABLE}.json`),
      JSON.stringify(normalise(exported as Array<Record<string, unknown>>)),
    );

    await pool.query(`DELETE FROM ${TABLE} WHERE sourceId = 'restore-keys-a'`);
    await pool.query(`UPDATE ${TABLE} SET encryptedPrivateKey = 'replaced' WHERE sourceId = 'restore-keys-b'`);
    await pool.query(
      `INSERT INTO ${TABLE} (sourceId, encryptedPrivateKey, createdAt, updatedAt) VALUES ('made-later', 'x', 1, 1)`,
    );
  });

  afterAll(async () => {
    if (backupDir) fs.rmSync(backupDir, { recursive: true, force: true });
    await cleanup?.();
  });

  it('restores every key row exactly, replacing what was there', async () => {
    // restoreMySQL takes a URL; reuse the credentials the isolated pool was
    // opened with rather than guessing the container's root password.
    const cfg = (pool as unknown as { pool: { config: { connectionConfig: { user: string; password: string } } } })
      .pool.config.connectionConfig;
    const url = `mysql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@localhost:3307/${databaseName}`;

    const result = await (systemRestoreService as unknown as { restoreMySQL: Restore }).restoreMySQL(
      backupDir,
      [TABLE],
      url,
    );
    expect(result).toEqual({ rowsRestored: 2, tablesRestored: 1 });

    const [rows] = await pool.query(`SELECT * FROM \`${TABLE}\``);
    expect(normalise(rows as Array<Record<string, unknown>>)).toEqual(BACKED_UP);
  });
});
