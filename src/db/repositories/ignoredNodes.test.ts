/**
 * Multi-Database Ignored Nodes Repository Tests
 *
 * Validates IgnoredNodesRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import * as schema from '../schema/index.js';
import { IgnoredNodesRepository } from './ignoredNodes.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

// SQL for creating the ignored_nodes table per backend
const SQLITE_CREATE = `
  CREATE TABLE IF NOT EXISTS ignored_nodes (
    nodeNum INTEGER PRIMARY KEY,
    nodeId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    ignoredBy TEXT,
    ignoredAt INTEGER NOT NULL,
    sourceId TEXT
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS ignored_nodes CASCADE;
  CREATE TABLE ignored_nodes (
    "nodeNum" BIGINT PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "ignoredBy" TEXT,
    "ignoredAt" BIGINT NOT NULL,
    "sourceId" TEXT
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS ignored_nodes;
  CREATE TABLE ignored_nodes (
    \`nodeNum\` BIGINT PRIMARY KEY,
    \`nodeId\` VARCHAR(255) NOT NULL,
    \`longName\` TEXT,
    \`shortName\` TEXT,
    \`ignoredBy\` TEXT,
    \`ignoredAt\` BIGINT NOT NULL,
    \`sourceId\` VARCHAR(36)
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

    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Test Node', 'TN', 'admin');

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeNum).toBe(12345);
    expect(nodes[0].nodeId).toBe('!abcd1234');
    expect(nodes[0].longName).toBe('Test Node');
    expect(nodes[0].shortName).toBe('TN');
    expect(nodes[0].ignoredBy).toBe('admin');
    expect(nodes[0].ignoredAt).toBeGreaterThan(0);
  });

  it('addIgnoredNodeAsync - upsert behavior (add same node twice)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Original Name', 'ON', 'user1');
    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Updated Name', 'UN', 'user2');

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeNum).toBe(12345);
    expect(nodes[0].longName).toBe('Updated Name');
    expect(nodes[0].shortName).toBe('UN');
    expect(nodes[0].ignoredBy).toBe('user2');
  });

  it('removeIgnoredNodeAsync - remove existing node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Test Node', 'TN', 'admin');
    await repo.addIgnoredNodeAsync(67890, '!efgh5678', 'Other Node', 'OT', 'admin');

    await repo.removeIgnoredNodeAsync(12345);

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeNum).toBe(67890);
  });

  it('removeIgnoredNodeAsync - no-op for nonexistent node', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Test Node', 'TN', 'admin');

    // Should not throw
    await repo.removeIgnoredNodeAsync(99999);

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
  });

  it('getIgnoredNodesAsync - list all ignored nodes', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Empty initially
    const empty = await repo.getIgnoredNodesAsync();
    expect(empty).toHaveLength(0);

    await repo.addIgnoredNodeAsync(11111, '!node1', 'Node One', 'N1', 'admin');
    await repo.addIgnoredNodeAsync(22222, '!node2', 'Node Two', 'N2', 'admin');
    await repo.addIgnoredNodeAsync(33333, '!node3', 'Node Three', 'N3', null);

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(3);

    const nodeNums = nodes.map(n => n.nodeNum).sort();
    expect(nodeNums).toEqual([11111, 22222, 33333]);
  });

  it('isNodeIgnoredAsync - true for ignored, false for not', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, '!abcd1234', 'Test Node', 'TN', 'admin');

    expect(await repo.isNodeIgnoredAsync(12345)).toBe(true);
    expect(await repo.isNodeIgnoredAsync(99999)).toBe(false);
  });

  it('addIgnoredNodeAsync - handles null optional fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.addIgnoredNodeAsync(12345, '!abcd1234');

    const nodes = await repo.getIgnoredNodesAsync();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].longName).toBeNull();
    expect(nodes[0].shortName).toBeNull();
    expect(nodes[0].ignoredBy).toBeNull();
  });
}

// --- SQLite Backend ---
describe('IgnoredNodesRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runIgnoredNodesTests(() => backend);
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
