/**
 * #5390 — `meshcore_nodes.firstHeard` (epoch MILLISECONDS, like MeshCore's
 * `lastHeard`) is stamped once and never overwritten, per source.
 *
 * Runs against the full migration registry (createTestDb), so it also proves
 * migration 178 added the column on SQLite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const KEY = 'bb'.repeat(32);
const T0 = 1_760_000_000_000; // 2025-10-09, epoch ms

describe('MeshCoreRepository — firstHeard (#5390)', () => {
  let db: Database.Database;
  let repo: MeshCoreRepository;

  const firstHeard = async (sourceId = SOURCE_A) =>
    (await repo.getNodeByPublicKeyAndSource(KEY, sourceId))?.firstHeard ?? null;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new MeshCoreRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('stamps firstHeard on insert and keeps it as lastHeard moves forward', async () => {
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 }, SOURCE_A);
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 + 60_000 }, SOURCE_A);
    await repo.markHeard(SOURCE_A, KEY, T0 + 120_000);
    expect(await firstHeard()).toBe(T0);
  });

  it('leaves firstHeard null for a contact never heard, then stamps the first reception', async () => {
    await repo.upsertNode({ publicKey: KEY, name: 'repeater' }, SOURCE_A);
    expect(await firstHeard()).toBeNull();
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 }, SOURCE_A);
    expect(await firstHeard()).toBe(T0);
  });

  it('takes a stale (older) reading as the first reception before one is stamped', async () => {
    // Row exists with no stamp yet (e.g. restored from an older backup).
    await repo.upsertNode({ publicKey: KEY, name: 'n' }, SOURCE_A);
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 }, SOURCE_A);
    // A later contact sync carrying an older advert time neither rewinds
    // lastHeard nor rewrites the stamped firstHeard.
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 - 3_600_000 }, SOURCE_A);
    expect(await firstHeard()).toBe(T0);
  });

  it('ignores drifted RTC values (year 2087) and caller-supplied firstHeard', async () => {
    const drifted = Date.UTC(2087, 0, 1);
    await repo.upsertNode({ publicKey: KEY, lastHeard: drifted }, SOURCE_A);
    expect(await firstHeard()).toBeNull();
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0, firstHeard: 5 }, SOURCE_A);
    expect(await firstHeard()).toBe(T0);
    await repo.upsertNode({ publicKey: KEY, firstHeard: T0 + 1 }, SOURCE_A);
    expect(await firstHeard()).toBe(T0);
  });

  it('keeps firstHeard per source', async () => {
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 }, SOURCE_A);
    await repo.upsertNode({ publicKey: KEY, lastHeard: T0 + 5_000 }, SOURCE_B);
    expect(await firstHeard(SOURCE_A)).toBe(T0);
    expect(await firstHeard(SOURCE_B)).toBe(T0 + 5_000);
  });
});
