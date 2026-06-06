/**
 * Sources Repository Tests
 *
 * Covers the displayOrder / drag-to-reorder behaviour added for issue #3338
 * alongside the basic CRUD ordering guarantees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { SourcesRepository } from './sources.js';
import * as schema from '../schema/index.js';

describe('SourcesRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: SourcesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        displayOrder INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        createdBy INTEGER
      )
    `);
    drizzleDb = drizzle(db, { schema });
    repo = new SourcesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  // Insert directly so we control createdAt (createSource stamps Date.now()).
  const insert = (id: string, displayOrder: number, createdAt: number) => {
    db.exec(
      `INSERT INTO sources (id, name, type, config, enabled, displayOrder, createdAt, updatedAt, createdBy)
       VALUES ('${id}', '${id}', 'meshtastic_tcp', '{}', 1, ${displayOrder}, ${createdAt}, ${createdAt}, NULL)`
    );
  };

  it('getAllSources orders by displayOrder, then createdAt', async () => {
    // All default-0; tie-break is creation order.
    insert('c', 0, 300);
    insert('a', 0, 100);
    insert('b', 0, 200);
    const sources = await repo.getAllSources();
    expect(sources.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('getAllSources respects explicit displayOrder ranks over createdAt', async () => {
    insert('a', 3, 100);
    insert('b', 1, 200);
    insert('c', 2, 300);
    const sources = await repo.getAllSources();
    expect(sources.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('reorderSources writes 1..N ranks and getAllSources reflects them', async () => {
    insert('a', 0, 100);
    insert('b', 0, 200);
    insert('c', 0, 300);

    const result = await repo.reorderSources(['c', 'a', 'b']);
    expect(result.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(result.map((s) => s.displayOrder)).toEqual([1, 2, 3]);

    // Persisted — a fresh read returns the same order.
    const reread = await repo.getAllSources();
    expect(reread.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('reorderSources rejects a payload that is not a full permutation', async () => {
    insert('a', 0, 100);
    insert('b', 0, 200);
    insert('c', 0, 300);
    await expect(repo.reorderSources(['a', 'b'])).rejects.toThrow(/every source exactly once/);
  });

  it('reorderSources rejects an unknown source id', async () => {
    insert('a', 0, 100);
    insert('b', 0, 200);
    await expect(repo.reorderSources(['a', 'zzz'])).rejects.toThrow(/Unknown source id/);
  });

  it('reorderSources rejects a duplicate source id', async () => {
    insert('a', 0, 100);
    insert('b', 0, 200);
    await expect(repo.reorderSources(['a', 'a'])).rejects.toThrow(/Duplicate source id/);
  });

  it('createSource appends new sources to the end after a reorder', async () => {
    insert('a', 0, 100);
    insert('b', 0, 200);
    await repo.reorderSources(['b', 'a']); // b=1, a=2

    const created = await repo.createSource({
      id: 'c',
      name: 'C',
      type: 'meshtastic_tcp',
      config: {},
    });
    expect(created.displayOrder).toBe(3);

    const sources = await repo.getAllSources();
    expect(sources.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});
