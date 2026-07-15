/**
 * Multi-Database Ignored Nodes Repository Tests
 *
 * Validates IgnoredNodesRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 *
 * Migration 048: the table is now per-source with composite PK (nodeNum, sourceId).
 * The FK to sources(id) is enforced by the migration but intentionally omitted
 * from the test CREATEs — these tests isolate repository semantics from the
 * sources lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from 'vitest';
import * as schema from '../schema/index.js';
import { IgnoredNodesRepository } from './ignoredNodes.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

// Note: SQLite DDL is now provided by createTestDb() via the migration registry.

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS ignored_nodes CASCADE;
  CREATE TABLE ignored_nodes (
    "nodeNum" BIGINT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "ignoredBy" TEXT,
    "ignoredAt" BIGINT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY ("nodeNum", "sourceId")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS ignored_nodes;
  CREATE TABLE ignored_nodes (
    \`nodeNum\` BIGINT NOT NULL,
    \`sourceId\` VARCHAR(36) NOT NULL,
    \`nodeId\` VARCHAR(255) NOT NULL,
    \`longName\` VARCHAR(255),
    \`shortName\` VARCHAR(255),
    \`ignoredBy\` VARCHAR(255),
    \`ignoredAt\` BIGINT NOT NULL,
    \`reason\` VARCHAR(16) NOT NULL DEFAULT 'manual',
    PRIMARY KEY (\`nodeNum\`, \`sourceId\`)
  )
`;

/**
 * Shared test suite that runs against any backend.
 * Call within a describe() block with a function that returns the current backend.
 */
function runIgnoredNodesTests(getBackend: () => TestBackend) {
  let repo: IgnoredNodesRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new IgnoredNodesRepository(backend.drizzleDb, backend.dbType);
  });

  it('addIgnoredNodeAsync - add a node and verify fields stored', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeNum).toBe(12345);
    expect(nodes[0].sourceId).toBe(SRC_A);
    expect(nodes[0].nodeId).toBe('!abcd1234');
    expect(nodes[0].longName).toBe('Test Node');
    expect(nodes[0].shortName).toBe('TN');
    expect(nodes[0].ignoredBy).toBe('admin');
    expect(nodes[0].ignoredAt).toBeGreaterThan(0);
  });

  it('addIgnoredNodeAsync - upsert behavior on same (nodeNum, sourceId)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Original Name', 'ON', 'user1');
    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Updated Name', 'UN', 'user2');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeNum).toBe(12345);
    expect(nodes[0].longName).toBe('Updated Name');
    expect(nodes[0].shortName).toBe('UN');
    expect(nodes[0].ignoredBy).toBe('user2');
  });

  it('addIgnoredNodeAsync - same nodeNum on different sources creates two rows', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'On A', 'A', 'admin');
    await repo.addIgnoredNodeAsync(12345, SRC_B, '!abcd1234', 'On B', 'B', 'admin');

    expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(true);
    expect(await repo.isNodeIgnoredAsync(12345, SRC_B)).toBe(true);

    const onA = await repo.getIgnoredNodesAsync(SRC_A);
    expect(onA).toHaveLength(1);
    expect(onA[0].longName).toBe('On A');

    const all = await repo.getIgnoredNodesAsync();
    expect(all).toHaveLength(2);
  });

  it('removeIgnoredNodeAsync - scoped to source', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'On A', 'A', 'admin');
    await repo.addIgnoredNodeAsync(12345, SRC_B, '!abcd1234', 'On B', 'B', 'admin');

    await repo.removeIgnoredNodeAsync(12345, SRC_A);

    expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(false);
    expect(await repo.isNodeIgnoredAsync(12345, SRC_B)).toBe(true);

    const all = await repo.getIgnoredNodesAsync();
    expect(all).toHaveLength(1);
    expect(all[0].sourceId).toBe(SRC_B);
  });

  it('removeIgnoredNodeAsync - no-op for nonexistent (nodeNum, sourceId)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    await repo.removeIgnoredNodeAsync(99999, SRC_A);
    await repo.removeIgnoredNodeAsync(12345, SRC_B);

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
  });

  it('getIgnoredNodesAsync - returns all rows when no sourceId filter', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getIgnoredNodesAsync()).toHaveLength(0);

    await repo.addIgnoredNodeAsync(11111, SRC_A, '!node1', 'Node One', 'N1', 'admin');
    await repo.addIgnoredNodeAsync(22222, SRC_A, '!node2', 'Node Two', 'N2', 'admin');
    await repo.addIgnoredNodeAsync(33333, SRC_B, '!node3', 'Node Three', 'N3', null);

    const all = await repo.getIgnoredNodesAsync();
    expect(all).toHaveLength(3);
  });

  it('getIgnoredNodesAsync - filters by sourceId when provided', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(11111, SRC_A, '!node1', 'Node One', 'N1', 'admin');
    await repo.addIgnoredNodeAsync(22222, SRC_A, '!node2', 'Node Two', 'N2', 'admin');
    await repo.addIgnoredNodeAsync(33333, SRC_B, '!node3', 'Node Three', 'N3', null);

    const onA = await repo.getIgnoredNodesAsync(SRC_A);
    expect(onA.map(n => n.nodeNum).sort()).toEqual([11111, 22222]);

    const onB = await repo.getIgnoredNodesAsync(SRC_B);
    expect(onB.map(n => n.nodeNum).sort()).toEqual([33333]);

    const unknown = await repo.getIgnoredNodesAsync('nonexistent-source');
    expect(unknown).toHaveLength(0);
  });

  it('isNodeIgnoredAsync - per-source truthiness', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(true);
    // Same nodeNum but different source — false. This is the new per-source
    // semantic that migration 048 introduced.
    expect(await repo.isNodeIgnoredAsync(12345, SRC_B)).toBe(false);
    expect(await repo.isNodeIgnoredAsync(99999, SRC_A)).toBe(false);
  });

  it('addIgnoredNodeAsync - handles null optional fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].longName).toBeNull();
    expect(nodes[0].shortName).toBeNull();
    expect(nodes[0].ignoredBy).toBeNull();
  });

  // --- In-memory cache mirror (issue #2601 auto-reapply) ---

  it('isIgnoredCached - reflects adds and removes without re-priming', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(false);

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');
    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(true);

    await repo.removeIgnoredNodeAsync(12345, SRC_A);
    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(false);
  });

  it('isIgnoredCached - is per-source scoped', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'On A', 'A', 'admin');

    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(true);
    expect(repo.isIgnoredCached(12345, SRC_B)).toBe(false);
    expect(repo.isIgnoredCached(99999, SRC_A)).toBe(false);
  });

  it('primeCacheAsync - loads existing rows from the table into the cache', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Persist rows directly through the repo, then build a fresh repo whose
    // cache starts empty — simulating a process restart with a populated table.
    await repo.addIgnoredNodeAsync(11111, SRC_A, '!node1', 'Node One', 'N1', 'admin');
    await repo.addIgnoredNodeAsync(22222, SRC_B, '!node2', 'Node Two', 'N2', null);

    const freshRepo = new IgnoredNodesRepository(backend.drizzleDb, backend.dbType);
    expect(freshRepo.isIgnoredCached(11111, SRC_A)).toBe(false);

    const primed = await freshRepo.primeCacheAsync();
    expect(primed).toBe(true);
    expect(freshRepo.isIgnoredCached(11111, SRC_A)).toBe(true);
    expect(freshRepo.isIgnoredCached(22222, SRC_B)).toBe(true);
    expect(freshRepo.isIgnoredCached(33333, SRC_A)).toBe(false);
  });

  // --- reason semantics (MQTT Geo-Ignore epic, Phase 1) ---

  it('addIgnoredNodeAsync - stamps reason "manual" and exposes it via getIgnoredNodesAsync', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reason).toBe('manual');
  });

  it('addGeoIgnoreAsync - inserts with reason "geo" and is cached', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reason).toBe('geo');
    expect(nodes[0].ignoredBy).toBe('geo-filter');
    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(true);
  });

  it('addGeoIgnoreAsync - does not downgrade an existing manual ignore', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');
    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reason).toBe('manual');
    expect(nodes[0].ignoredBy).toBe('admin');
  });

  it('addGeoIgnoreAsync - idempotent, a second call produces a single geo row', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');
    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reason).toBe('geo');
  });

  it('addIgnoredNodeAsync - upgrades an existing geo ignore to manual', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');
    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reason).toBe('manual');
    expect(nodes[0].ignoredBy).toBe('admin');
  });

  it('liftGeoIgnoreAsync - on a geo ignore removes the row and returns true', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');

    const lifted = await repo.liftGeoIgnoreAsync(12345, SRC_A);
    expect(lifted).toBe(true);

    expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(false);
    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(false);
  });

  it('liftGeoIgnoreAsync - on a manual ignore is a no-op and returns false', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');

    const lifted = await repo.liftGeoIgnoreAsync(12345, SRC_A);
    expect(lifted).toBe(false);

    expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(true);
    expect(repo.isIgnoredCached(12345, SRC_A)).toBe(true);
    const nodes = await repo.getIgnoredNodesAsync(SRC_A);
    expect(nodes[0].reason).toBe('manual');
  });

  it('liftGeoIgnoreAsync - on an absent row returns false', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const lifted = await repo.liftGeoIgnoreAsync(99999, SRC_A);
    expect(lifted).toBe(false);
  });

  it('liftGeoIgnoreAsync - concurrent manual upgrade between read and delete keeps node ignored (phantom un-ignore regression)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Seed a geo row so liftGeoIgnoreAsync's initial SELECT sees reason='geo'.
    await repo.addGeoIgnoreAsync(12345, SRC_A, '!abcd1234', 'Far Node', 'FN');

    // Interleave: intercept the guarded DELETE and upgrade the row to
    // 'manual' first — simulating a concurrent addIgnoredNodeAsync winning
    // the race between liftGeoIgnoreAsync's initial read and its delete.
    // Reaching into the repo's protected drizzle handle to interleave the
    // race deterministically.
    const db: any = (repo as any).db;
    const origDelete = db.delete.bind(db);
    const deleteSpy = vi.spyOn(db, 'delete').mockImplementationOnce((table: unknown) => ({
      where: (cond: unknown) => (async () => {
        await repo.addIgnoredNodeAsync(12345, SRC_A, '!abcd1234', 'Test Node', 'TN', 'admin');
        // Pass-through to the real drizzle builder.
        return await origDelete(table as any).where(cond as any);
      })(),
    }));

    try {
      const lifted = await repo.liftGeoIgnoreAsync(12345, SRC_A);

      // The lift must observe that the row survived (now 'manual') and
      // report failure WITHOUT evicting the cache entry.
      expect(lifted).toBe(false);
      expect(repo.isIgnoredCached(12345, SRC_A)).toBe(true);
      expect(await repo.isNodeIgnoredAsync(12345, SRC_A)).toBe(true);

      const nodes = await repo.getIgnoredNodesAsync(SRC_A);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].reason).toBe('manual');
      expect(nodes[0].ignoredBy).toBe('admin');
    } finally {
      deleteSpy.mockRestore();
    }
  });
}

// --- SQLite Backend ---
describe('IgnoredNodesRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    // Seed the sources referenced by SRC_A and SRC_B so the FK from
    // ignored_nodes.sourceId → sources.id (migration 048) is satisfied.
    t.sqlite.prepare(
      `INSERT OR IGNORE INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 0, 0)`,
    ).run(SRC_A, SRC_A);
    t.sqlite.prepare(
      `INSERT OR IGNORE INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 0, 0)`,
    ).run(SRC_B, SRC_B);
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runIgnoredNodesTests(() => backend);

  it('primeCacheSqlite - synchronously loads existing rows into the cache', async () => {
    const repo = new IgnoredNodesRepository(backend.drizzleDb, backend.dbType);
    await repo.addIgnoredNodeAsync(44444, SRC_A, '!node4', 'Node Four', 'N4', 'admin');

    // Fresh repo: cache empty until primed (synchronously, mirroring the
    // DatabaseService SQLite constructor path).
    const freshRepo = new IgnoredNodesRepository(backend.drizzleDb, backend.dbType);
    expect(freshRepo.isIgnoredCached(44444, SRC_A)).toBe(false);

    const primed = freshRepo.primeCacheSqlite();
    expect(primed).toBe(true);
    expect(freshRepo.isIgnoredCached(44444, SRC_A)).toBe(true);
    expect(freshRepo.isIgnoredCached(44444, SRC_B)).toBe(false);
  });
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('IgnoredNodesRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for ignored nodes tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'ignored_nodes');
  });

  runIgnoredNodesTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('IgnoredNodesRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for ignored nodes tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'ignored_nodes');
  });

  runIgnoredNodesTests(() => backend);
});

// Re-export schema as a no-op reference so the import isn't dead if test-utils
// ever evolves to consume it.
void schema;
