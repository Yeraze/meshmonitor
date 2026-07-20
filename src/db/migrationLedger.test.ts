/**
 * Migration ledger (PostgreSQL / MySQL) — #4233
 *
 * Before the ledger, `createPostgresSchema` / `createMySQLSchema` re-ran every
 * registered migration on every boot, relying entirely on each migration being
 * internally idempotent. Migration 030 was not, so every restart cleared and
 * rebuilt the whole `route_segments` table.
 *
 * These tests pin the guard: a migration recorded in the ledger must not run
 * again, one that is not recorded must run and then be recorded.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readAppliedMigrationsPostgres,
  markMigrationAppliedPostgres,
  readAppliedMigrationsMysql,
  markMigrationAppliedMysql,
  runLedgeredMigrations,
  MIGRATION_COMPLETED,
} from './migrationLedger.js';
import type { MigrationEntry } from './migrationRegistry.js';

/** Minimal fake `pg` client: canned responses matched on SQL substrings. */
function fakePgClient(opts: { settingsTableExists: boolean; appliedKeys?: string[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const client = {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: opts.settingsTableExists }] };
      }
      if (sql.includes('SELECT key FROM settings')) {
        return { rows: (opts.appliedKeys ?? []).map(key => ({ key })) };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return client;
}

/** Minimal fake mysql2 pool. */
function fakeMysqlPool(opts: { settingsTableExists: boolean; appliedKeys?: string[] }) {
  const queries: { sql: string; params?: any[] }[] = [];
  const pool = {
    queries,
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.TABLES')) {
        return [[{ count: opts.settingsTableExists ? 1 : 0 }]];
      }
      if (sql.includes('FROM settings')) {
        return [(opts.appliedKeys ?? []).map(key => ({ key }))];
      }
      return [{}];
    }),
  };
  return pool;
}

function entry(number: number, overrides: Partial<MigrationEntry> = {}): MigrationEntry {
  return {
    number,
    name: `migration-${number}`,
    settingsKey: `migration_${String(number).padStart(3, '0')}_test`,
    ...overrides,
  };
}

describe('migration ledger — PostgreSQL', () => {
  it('returns an empty set when the settings table does not exist yet', async () => {
    const client = fakePgClient({ settingsTableExists: false });
    await expect(readAppliedMigrationsPostgres(client)).resolves.toEqual(new Set());
  });

  it('reads recorded migration keys', async () => {
    const client = fakePgClient({
      settingsTableExists: true,
      appliedKeys: ['migration_030_route_segments', 'migration_031_other'],
    });
    const applied = await readAppliedMigrationsPostgres(client);
    expect(applied.has('migration_030_route_segments')).toBe(true);
    expect(applied.size).toBe(2);
  });

  it('only reads keys marked completed', async () => {
    const client = fakePgClient({ settingsTableExists: true });
    await readAppliedMigrationsPostgres(client);
    const read = client.queries.find(q => q.sql.includes('SELECT key FROM settings'));
    expect(read?.params).toEqual([MIGRATION_COMPLETED]);
  });

  it('records a migration as an idempotent upsert', async () => {
    const client = fakePgClient({ settingsTableExists: true });
    await markMigrationAppliedPostgres(client, 'migration_030_route_segments');
    const insert = client.queries.at(-1)!;
    expect(insert.sql).toContain('ON CONFLICT (key) DO UPDATE');
    expect(insert.params?.[0]).toBe('migration_030_route_segments');
    expect(insert.params?.[1]).toBe(MIGRATION_COMPLETED);
  });
});

describe('migration ledger — MySQL', () => {
  it('returns an empty set when the settings table does not exist yet', async () => {
    const pool = fakeMysqlPool({ settingsTableExists: false });
    await expect(readAppliedMigrationsMysql(pool)).resolves.toEqual(new Set());
  });

  it('reads recorded migration keys', async () => {
    const pool = fakeMysqlPool({
      settingsTableExists: true,
      appliedKeys: ['migration_030_route_segments'],
    });
    const applied = await readAppliedMigrationsMysql(pool);
    expect(applied.has('migration_030_route_segments')).toBe(true);
  });

  it('records a migration as an idempotent upsert', async () => {
    const pool = fakeMysqlPool({ settingsTableExists: true });
    await markMigrationAppliedMysql(pool, 'migration_030_route_segments');
    const insert = pool.queries.at(-1)!;
    expect(insert.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(insert.params?.[0]).toBe('migration_030_route_segments');
  });
});

describe('runLedgeredMigrations', () => {
  const harness = (applied: string[]) => ({
    readApplied: async () => new Set(applied),
    markApplied: vi.fn(async () => {}),
  });

  it('skips migrations already recorded in the ledger', async () => {
    const ran: number[] = [];
    const migrations = [entry(2), entry(3), entry(4)];
    const { readApplied, markApplied } = harness([
      'migration_002_test',
      'migration_004_test',
    ]);

    const result = await runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: m => async () => { ran.push(m.number); },
      readApplied,
      markApplied,
    });

    expect(ran).toEqual([3]);
    expect(result).toEqual({ ran: 1, skipped: 2 });
  });

  it('records each migration it runs', async () => {
    const migrations = [entry(2), entry(3)];
    const { readApplied, markApplied } = harness([]);

    await runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: () => async () => {},
      readApplied,
      markApplied,
    });

    expect(markApplied).toHaveBeenCalledTimes(2);
    expect(markApplied).toHaveBeenCalledWith({}, 'migration_002_test');
    expect(markApplied).toHaveBeenCalledWith({}, 'migration_003_test');
  });

  it('always runs the baseline migration, which has no settingsKey', async () => {
    const ran: number[] = [];
    const migrations = [entry(1, { settingsKey: undefined }), entry(2)];
    const { readApplied, markApplied } = harness(['migration_002_test']);

    await runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: m => async () => { ran.push(m.number); },
      readApplied,
      markApplied,
    });

    // 001 runs (it creates the settings table the ledger lives in) but is not
    // recorded; 002 is skipped because the ledger already has it.
    expect(ran).toEqual([1]);
    expect(markApplied).not.toHaveBeenCalled();
  });

  it('skips migrations with no implementation for this backend', async () => {
    const migrations = [entry(2), entry(3)];
    const { readApplied, markApplied } = harness([]);

    const result = await runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: m => (m.number === 3 ? async () => {} : undefined),
      readApplied,
      markApplied,
    });

    expect(result).toEqual({ ran: 1, skipped: 0 });
  });

  it('does not record a migration that threw, so it retries next boot', async () => {
    const migrations = [entry(2)];
    const { readApplied, markApplied } = harness([]);

    await expect(runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: () => async () => { throw new Error('boom'); },
      readApplied,
      markApplied,
    })).rejects.toThrow('boom');

    expect(markApplied).not.toHaveBeenCalled();
  });

  it('runs everything on a pre-existing database with an empty ledger', async () => {
    // The one-time post-ledger replay: nothing is recorded yet, so all
    // migrations run once and are then recorded.
    const migrations = [entry(2), entry(3), entry(4)];
    const { readApplied, markApplied } = harness([]);

    const result = await runLedgeredMigrations({
      backend: 'Test',
      handle: {},
      migrations,
      pick: () => async () => {},
      readApplied,
      markApplied,
    });

    expect(result).toEqual({ ran: 3, skipped: 0 });
    expect(markApplied).toHaveBeenCalledTimes(3);
  });
});
