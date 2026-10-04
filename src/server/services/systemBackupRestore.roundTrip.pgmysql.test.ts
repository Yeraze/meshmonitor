/**
 * System backup → restore on real PostgreSQL and MySQL, for EVERY table in the
 * backup, plus the table-list drift checks against each server's real schema.
 *
 * The SQLite round trip (systemBackupRestore.roundTrip.test.ts) runs through
 * the service entry points. Here the same streaming reader, file writer and
 * restore paths run against a database built by replaying every migration on
 * the real server, in a private database per suite.
 *
 * The restore paths differ per backend in ways only a real server shows:
 * PostgreSQL quotes camelCase columns, returns BIGINT as strings, and refuses
 * an explicit id on a GENERATED ALWAYS identity column; MySQL stores booleans
 * as TINYINT. Until this change neither path checked table names against the
 * backup allowlist, which SQLite's did.
 *
 * Both suites skip silently when the containers are down, so confirm coverage
 * via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type pg from 'pg';
import type mysql from 'mysql2/promise';
import { registry } from '../../db/migrations.js';
import {
  readAppliedMigrationsPostgres,
  markMigrationAppliedPostgres,
  readAppliedMigrationsMysql,
  markMigrationAppliedMysql,
  runLedgeredMigrations,
} from '../../db/migrationLedger.js';
import {
  postgresAvailable,
  mysqlAvailable,
  createIsolatedPostgresDatabase,
  createIsolatedMysqlDatabase,
} from '../../db/repositories/test-utils.js';

// The restore paths under test open their own pool from a URL; they never
// touch the app's DatabaseService.
vi.mock('../../services/database.js', () => ({ default: {} }));

import { logger } from '../../utils/logger.js';
import { systemRestoreService } from './systemRestoreService.js';
import { BACKUP_TABLES } from './systemBackupTables.js';
import { HOW_TO_FIX, classifyTables, misorderedForeignKeys } from './systemBackupTables.testHelpers.js';
import { openBackupReadSession, writeTableFile, type BackupDatabase } from './systemBackupIo.js';
import { buildSeedRow, seedTables, type SeedAdapter, type SeedRow } from './systemBackupRestore.testSeed.js';

type RestoreResult = { rowsRestored: number; tablesRestored: number };

/** Everything the shared tests need from one backend. */
interface Backend {
  adapter: SeedAdapter;
  database: BackupDatabase;
  /** Run a statement; `?` placeholders, identifiers already quoted via `q`. */
  query(sql: string, params?: unknown[]): Promise<SeedRow[]>;
  /** Quote an identifier. */
  q(identifier: string): string;
  tables(): Promise<string[]>;
  foreignKeys(): Promise<Array<{ child: string; parent: string }>>;
  restore(dir: string, tables: string[]): Promise<RestoreResult>;
  cleanup(): Promise<void>;
}

async function openPostgres(): Promise<Backend> {
  const { pool, databaseName, cleanup } = await createIsolatedPostgresDatabase('backuproundtrip');
  const client = await pool.connect();
  try {
    await runLedgeredMigrations({
      backend: 'PostgreSQL', handle: client, migrations: registry.getAll(), pick: (m) => m.postgres,
      readApplied: readAppliedMigrationsPostgres, markApplied: markMigrationAppliedPostgres,
    });
  } finally {
    client.release();
  }
  const url = `postgres://test:test@localhost:5433/${databaseName}`;
  const q = (identifier: string) => `"${identifier}"`;
  const query = async (sql: string, params: unknown[] = []) => {
    let i = 0;
    return (await (pool as pg.Pool).query(sql.replace(/\?/g, () => `$${++i}`), params)).rows as SeedRow[];
  };
  return {
    database: { type: 'postgres', pool },
    q,
    query,
    adapter: {
      dialect: 'postgres',
      async columns(table) {
        const rows = await query(
          `SELECT column_name AS name, data_type AS type FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
          [table],
        );
        return rows.map((r) => ({ name: String(r.name), type: String(r.type).toLowerCase() }));
      },
      async foreignKeys(table) {
        const rows = await query(
          `SELECT a.attname AS col, parent.relname AS parent, pa.attname AS parent_col
           FROM pg_constraint c
           JOIN pg_class child ON child.oid = c.conrelid
           JOIN pg_class parent ON parent.oid = c.confrelid
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
           JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
           WHERE c.contype = 'f' AND child.relname = ?`,
          [table],
        );
        return rows.map((r) => ({
          column: String(r.col), parentTable: String(r.parent), parentColumn: String(r.parent_col),
        }));
      },
      async insert(table, row) {
        const columns = Object.keys(row);
        await query(
          `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) OVERRIDING SYSTEM VALUE
           VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((c) => row[c]),
        );
      },
    },
    async tables() {
      const rows = await query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      );
      return rows.map((r) => String(r.name));
    },
    async foreignKeys() {
      const rows = await query(
        `SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint c
         JOIN pg_class child ON child.oid = c.conrelid
         JOIN pg_class parent ON parent.oid = c.confrelid
         WHERE c.contype = 'f'`,
      );
      return rows.map((r) => ({ child: String(r.child), parent: String(r.parent) }));
    },
    restore: (dir, tables) =>
      (systemRestoreService as unknown as {
        restorePostgres: (p: string, t: string[], u: string) => Promise<RestoreResult>;
      }).restorePostgres(dir, tables, url),
    cleanup,
  };
}

async function openMysql(): Promise<Backend> {
  const { pool, databaseName, cleanup } = await createIsolatedMysqlDatabase('backuproundtrip');
  await runLedgeredMigrations({
    backend: 'MySQL', handle: pool, migrations: registry.getAll(), pick: (m) => m.mysql,
    readApplied: readAppliedMigrationsMysql, markApplied: markMigrationAppliedMysql,
  });
  // restoreMySQL takes a URL; reuse the credentials the isolated pool was
  // opened with rather than guessing the container's root password.
  const cfg = (pool as unknown as { pool: { config: { connectionConfig: { user: string; password: string } } } })
    .pool.config.connectionConfig;
  const url = `mysql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(cfg.password)}@localhost:3307/${databaseName}`;
  const q = (identifier: string) => `\`${identifier}\``;
  const query = async (sql: string, params: unknown[] = []) =>
    (await (pool as mysql.Pool).query(sql, params))[0] as SeedRow[];
  return {
    database: { type: 'mysql', pool },
    q,
    query,
    adapter: {
      dialect: 'mysql',
      async columns(table) {
        const rows = await query(
          `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
          [table],
        );
        return rows.map((r) => ({ name: String(r.name), type: String(r.type).toLowerCase() }));
      },
      async foreignKeys(table) {
        const rows = await query(
          `SELECT COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS parent, REFERENCED_COLUMN_NAME AS parent_col
           FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [table],
        );
        return rows.map((r) => ({
          column: String(r.col), parentTable: String(r.parent), parentColumn: String(r.parent_col),
        }));
      },
      async insert(table, row) {
        const columns = Object.keys(row);
        await query(
          `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((c) => row[c]),
        );
      },
    },
    async tables() {
      const rows = await query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
      );
      return rows.map((r) => String(r.name));
    },
    async foreignKeys() {
      const rows = await query(
        `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
         FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`,
      );
      return rows.map((r) => ({ child: String(r.child), parent: String(r.parent) }));
    },
    restore: (dir, tables) =>
      (systemRestoreService as unknown as {
        restoreMySQL: (p: string, t: string[], u: string) => Promise<RestoreResult>;
      }).restoreMySQL(dir, tables, url),
    cleanup,
  };
}

function defineSuite(name: string, available: boolean, open: () => Promise<Backend>): void {
  describe.skipIf(!available)(`system backup → restore on ${name} (container)`, () => {
    let backend: Backend;
    let root: string;

    const dir = (label: string) => {
      const made = path.join(root, label);
      fs.mkdirSync(made, { recursive: true });
      return made;
    };
    const count = async (table: string) =>
      Number((await backend.query(`SELECT COUNT(*) AS n FROM ${backend.q(table)}`))[0].n);
    const wipe = async () => {
      for (const table of [...BACKUP_TABLES].reverse()) await backend.query(`DELETE FROM ${backend.q(table)}`);
    };
    /** Export every backed-up table the way the backup service does. */
    const exportAll = async (to: string, batchRows = 2) => {
      const session = await openBackupReadSession(backend.database, batchRows);
      try {
        for (const table of BACKUP_TABLES) {
          await writeTableFile(path.join(to, `${table}.json`), session.batches(table));
        }
      } finally {
        await session.close();
      }
    };
    /** A table file's rows as sorted lines: order on the server is not promised. */
    const rowsOf = (from: string, table: string) =>
      fs
        .readFileSync(path.join(from, `${table}.json`), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => line.replace(/,$/, ''))
        .sort();
    const captureWarnings = async <T,>(run: () => Promise<T>) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const result = await run();
        return { result, warned: warn.mock.calls.map((c) => String(c[0])).join('\n') };
      } finally {
        warn.mockRestore();
      }
    };

    let backupDir: string;

    beforeAll(async () => {
      backend = await open();
      root = fs.mkdtempSync(path.join(os.tmpdir(), `mm-backup-roundtrip-${name.toLowerCase()}-`));

      // The state to back up: three rows in every table.
      await wipe();
      await seedTables(backend.adapter, BACKUP_TABLES, 3);
      backupDir = dir('backup');
      await exportAll(backupDir);
    }, 600_000);

    afterAll(async () => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
      await backend?.cleanup();
    });

    describe('table lists against this server\'s schema', () => {
      it('has no table that is neither backed up nor excluded', async () => {
        const tables = await backend.tables();
        expect(tables.length).toBeGreaterThan(50);
        const result = classifyTables(tables);
        expect(result.unclassified, HOW_TO_FIX).toEqual([]);
        expect(result.staleBackup).toEqual([]);
        expect(result.staleExcluded).toEqual([]);
      });

      it('restores every foreign-key parent before its children', async () => {
        const edges = await backend.foreignKeys();
        expect(edges.length).toBeGreaterThan(10);
        expect(misorderedForeignKeys(edges), 'move the parent above the child in BACKUP_TABLES').toEqual([]);
      });
    });

    it('the streamed export holds every seeded row of every table', () => {
      for (const table of BACKUP_TABLES) {
        expect(rowsOf(backupDir, table), table).toHaveLength(3);
      }
    });

    it('restores every table to exactly what was backed up', async () => {
      // What a restore has to undo: everything gone, different rows in place.
      await wipe();
      await seedTables(backend.adapter, BACKUP_TABLES, 2, 70);

      const result = await backend.restore(backupDir, BACKUP_TABLES);
      expect(result).toEqual({ tablesRestored: BACKUP_TABLES.length, rowsRestored: BACKUP_TABLES.length * 3 });

      const after = dir('after-restore');
      await exportAll(after, 1000);
      for (const table of BACKUP_TABLES) {
        expect(rowsOf(after, table), table).toEqual(rowsOf(backupDir, table));
      }
    });

    it('restores in BACKUP_TABLES order even when the backup lists children first', async () => {
      await wipe();
      const result = await backend.restore(backupDir, [...BACKUP_TABLES].reverse());
      expect(result.tablesRestored).toBe(BACKUP_TABLES.length);
      // Children of `users` and `sources` survive: their parents were refilled
      // first, not cleared after them.
      for (const table of ['permissions', 'api_tokens', 'channel_database_permissions', 'waypoints']) {
        expect(await count(table), table).toBe(3);
      }
    });

    it('a row inserted after the restore gets a fresh id', async () => {
      const row = await buildSeedRow(backend.adapter, 'mqtt_packet_log', 90, new Map());
      delete row.id;
      const columns = Object.keys(row);
      await backend.query(
        `INSERT INTO ${backend.q('mqtt_packet_log')} (${columns.map(backend.q).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => row[c]),
      );
      const ids = (await backend.query(`SELECT id FROM ${backend.q('mqtt_packet_log')}`)).map((r) => Number(r.id));
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
      expect(Math.max(...ids)).toBeGreaterThan(1003);
    });

    describe('a crafted metadata.json naming tables outside the allowlist', () => {
      const INJECTION = 'users"; DROP TABLE users; --';
      const BACKTICK_INJECTION = 'users`; DROP TABLE users; -- ';

      it('restores only allowlisted tables; excluded and hostile names are skipped with a warning', async () => {
        const crafted = dir('crafted');
        fs.copyFileSync(path.join(backupDir, 'nodes.json'), path.join(crafted, 'nodes.json'));
        // Each hostile name gets a table file, so only the allowlist stands
        // between it and the database. `push_subscriptions` is a REAL table
        // that backups exclude: before the allowlist these two paths would
        // have emptied it.
        for (const hostile of ['push_subscriptions', 'sessions', INJECTION, BACKTICK_INJECTION]) {
          fs.writeFileSync(path.join(crafted, `${hostile}.json`), '[]');
        }
        const users = await backend.query(`SELECT * FROM ${backend.q('users')}`);
        await backend.adapter.insert(
          'push_subscriptions',
          await buildSeedRow(backend.adapter, 'push_subscriptions', 40, new Map([['users', users]])),
        );
        expect(await count('push_subscriptions')).toBe(1);
        await backend.query(`DELETE FROM ${backend.q('nodes')}`);

        const requested = ['nodes', 'push_subscriptions', 'sessions', INJECTION, BACKTICK_INJECTION, 'pg_authid'];
        const { result, warned } = await captureWarnings(() => backend.restore(crafted, requested));

        expect(result).toEqual({ tablesRestored: 1, rowsRestored: 3 });
        expect(await count('nodes')).toBe(3);
        for (const name of requested.slice(1)) {
          expect(warned).toContain(`Skipping table not in backup allowlist: ${name}`);
        }
        // The excluded table kept its row, and `users` is still there.
        expect(await count('push_subscriptions')).toBe(1);
        expect(await count('users')).toBe(3);
      });

      it('rejects a column name that is not a plain identifier, and rolls back', async () => {
        const crafted = dir('crafted-column');
        const rows = rowsOf(backupDir, 'nodes').map((line) => ({
          ...JSON.parse(line),
          'nodeId") VALUES (1); DROP TABLE users; --': 1,
        }));
        fs.writeFileSync(path.join(crafted, 'nodes.json'), JSON.stringify(rows));

        await expect(backend.restore(crafted, ['nodes'])).rejects.toThrow(
          /Invalid column name in backup for table nodes/,
        );
        // Rolled back: the rows cleared inside the failed transaction are back.
        expect(await count('nodes')).toBe(3);
        expect(await count('users')).toBe(3);
      });
    });

    describe('a backup made before this change', () => {
      it('restores its tables from 1.0-format files and leaves a table it lacks alone', async () => {
        const older = dir('older');
        for (const table of ['sources', 'users', 'nodes']) {
          // 1.0 wrote the whole array pretty-printed.
          const rows = rowsOf(backupDir, table).map((line) => JSON.parse(line));
          fs.writeFileSync(path.join(older, `${table}.json`), JSON.stringify(rows, null, 2));
        }
        const mcBefore = await count('meshcore_nodes');
        const automationsBefore = await count('automations');
        expect(mcBefore).toBeGreaterThan(0);
        expect(await count('waypoints')).toBeGreaterThan(0);
        await backend.query(`DELETE FROM ${backend.q('nodes')}`);

        const result = await backend.restore(older, ['sources', 'users', 'nodes']);
        expect(result).toEqual({ tablesRestored: 3, rowsRestored: 9 });
        expect(await count('nodes')).toBe(3);

        // Absent from the backup: left exactly as it was.
        expect(await count('meshcore_nodes')).toBe(mcBefore);
        expect(await count('automations')).toBe(automationsBefore);
        // Absent from the backup AND a cascade child of a replaced parent:
        // cleared by the database when `sources` / `users` were cleared.
        expect(await count('waypoints')).toBe(0);
        expect(await count('api_tokens')).toBe(0);
      });
    });

    describe('a backup that lacks a column the schema now has', () => {
      it('fills the missing column with its default', async () => {
        const fewer = dir('fewer-columns');
        const rows = rowsOf(backupDir, 'meshcore_nodes').map((line) => {
          const { roomSyncIntervalMinutes: _dropped, ...rest } = JSON.parse(line);
          return rest;
        });
        fs.writeFileSync(path.join(fewer, 'meshcore_nodes.json'), JSON.stringify(rows));

        const result = await backend.restore(fewer, ['meshcore_nodes']);
        expect(result).toEqual({ tablesRestored: 1, rowsRestored: 3 });
        const restored = await backend.query(
          `SELECT ${backend.q('roomSyncIntervalMinutes')} AS v FROM ${backend.q('meshcore_nodes')}`,
        );
        expect(restored.map((r) => Number(r.v))).toEqual([60, 60, 60]);
      });
    });

    describe('restore is all-or-nothing', () => {
      it('a failure in the last table leaves every earlier table as it was', async () => {
        await wipe();
        await seedTables(backend.adapter, BACKUP_TABLES, 1, 80);
        const before = dir('before-failed-restore');
        await exportAll(before, 1000);

        const broken = dir('broken-last-table');
        for (const table of BACKUP_TABLES) {
          fs.copyFileSync(path.join(backupDir, `${table}.json`), path.join(broken, `${table}.json`));
        }
        const last = BACKUP_TABLES[BACKUP_TABLES.length - 1];
        fs.writeFileSync(path.join(broken, `${last}.json`), JSON.stringify([{ no_such_column_in_this_table: 1 }]));

        await expect(backend.restore(broken, BACKUP_TABLES)).rejects.toThrow();

        const after = dir('after-failed-restore');
        await exportAll(after, 1000);
        for (const table of BACKUP_TABLES) {
          expect(rowsOf(after, table), table).toEqual(rowsOf(before, table));
        }
      });
    });
  });
}

defineSuite('PostgreSQL', postgresAvailable, openPostgres);
defineSuite('MySQL', mysqlAvailable, openMysql);
