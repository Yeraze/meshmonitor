/**
 * systemRestoreService.restorePostgres — real PostgreSQL regression.
 *
 * A restore re-inserts rows with their original ids. Before the fix it never
 * advanced SERIAL sequences, so the next id-less INSERT collided (plain
 * insert: duplicate key; insertIgnore / onConflictDoNothing(): row silently
 * dropped). Runs against localhost:5433 in an isolated database;
 * `describe.skipIf(!postgresAvailable)` skips silently, so confirm coverage
 * via `numPendingTests` in the JSON reporter.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { postgresAvailable, createIsolatedPostgresDatabase } from '../../db/repositories/test-utils.js';

// restorePostgres never touches the app's DatabaseService; stub it so the
// import doesn't open a real database.
vi.mock('../../services/database.js', () => ({ default: {} }));

import { systemRestoreService } from './systemRestoreService.js';

const restoreTable = pgTable('restore_seq_probe', {
  id: serial('id').primaryKey(),
  label: text('label'),
});

describe.skipIf(!postgresAvailable)('systemRestoreService.restorePostgres — sequences (container)', () => {
  let pool: pg.Pool;
  let databaseName: string;
  let cleanup: (() => Promise<void>) | undefined;
  let backupDir: string;

  beforeAll(async () => {
    ({ pool, databaseName, cleanup } = await createIsolatedPostgresDatabase('restoreseq'));
    await pool.query('CREATE TABLE restore_seq_probe (id SERIAL PRIMARY KEY, label TEXT)');
    // Live rows before the restore: the sequence sits at 2, so without the
    // fix the first post-restore insert draws 3, a restored id.
    await pool.query(`INSERT INTO restore_seq_probe (label) VALUES ('live1'), ('live2')`);

    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-restore-seq-'));
    const rows = [1, 2, 3, 40].map((id) => ({ id, label: `backup${id}` }));
    fs.writeFileSync(path.join(backupDir, 'restore_seq_probe.json'), JSON.stringify(rows));
  });

  afterAll(async () => {
    fs.rmSync(backupDir, { recursive: true, force: true });
    await cleanup?.();
  });

  it('advances sequences so later inserts get fresh ids instead of colliding or being dropped', async () => {
    const url = `postgres://test:test@localhost:5433/${databaseName}`;
    // restorePostgres is private; call it directly with a URL the test owns.
    const result = await (systemRestoreService as unknown as {
      restorePostgres: (p: string, t: string[], u: string) => Promise<{ rowsRestored: number; tablesRestored: number }>;
    }).restorePostgres(backupDir, ['restore_seq_probe'], url);
    expect(result).toEqual({ rowsRestored: 4, tablesRestored: 1 });

    const { rows: restored } = await pool.query('SELECT id FROM restore_seq_probe ORDER BY id');
    expect(restored.map((r) => r.id)).toEqual([1, 2, 3, 40]);

    // Plain insert: next id past the highest restored id.
    const { rows: plain } = await pool.query(
      `INSERT INTO restore_seq_probe (label) VALUES ('after') RETURNING id`,
    );
    expect(plain[0].id).toBe(41);

    // insertIgnore-style: BaseRepository.insertIgnore on PG is a target-less
    // onConflictDoNothing(), which would silently drop a colliding row.
    const db = drizzle(pool);
    const ignored = await db
      .insert(restoreTable)
      .values({ label: 'ignore-style' })
      .onConflictDoNothing()
      .returning({ id: restoreTable.id });
    expect(ignored).toEqual([{ id: 42 }]);

    const { rows: count } = await pool.query('SELECT COUNT(*)::int AS n FROM restore_seq_probe');
    expect(count[0].n).toBe(6);
  });
});
