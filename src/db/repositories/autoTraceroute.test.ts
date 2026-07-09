/**
 * Multi-Database AutoTraceroute Repository Tests
 *
 * Validates AutoTracerouteRepository against SQLite, PostgreSQL, and MySQL backends
 * using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory)
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { AutoTracerouteRepository } from './autoTraceroute.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';


const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS auto_traceroute_nodes CASCADE;
  CREATE TABLE auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT,
    UNIQUE("nodeNum", "sourceId")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS auto_traceroute_nodes;
  CREATE TABLE auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(64),
    UNIQUE(nodeNum, sourceId)
  )
`;

const ALL_TABLES = ['auto_traceroute_nodes'];

/**
 * Shared test suite that runs against any backend.
 */
function runAutoTracerouteTests(getBackend: () => TestBackend) {
  let repo: AutoTracerouteRepository;

  beforeEach(async () => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new AutoTracerouteRepository(backend.drizzleDb, backend.dbType);
  });

  // ============ AUTO-TRACEROUTE NODES ============

  it('getAutoTracerouteNodes - empty initially', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(0);
  });

  it('setAutoTracerouteNodes - replaces all entries', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200, 300]);
    let nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(3);
    expect(nodes.sort()).toEqual([100, 200, 300]);

    // Replace with different set
    await repo.setAutoTracerouteNodes([400, 500]);
    nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(2);
    expect(nodes.sort()).toEqual([400, 500]);
  });

  it('setAutoTracerouteNodes - empty array clears all', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200]);
    await repo.setAutoTracerouteNodes([]);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toHaveLength(0);
  });

  it('addAutoTracerouteNode - adds single node', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.addAutoTracerouteNode(12345);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).toContain(12345);
  });

  it('addAutoTracerouteNode - idempotent for duplicate', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.addAutoTracerouteNode(12345);
    await repo.addAutoTracerouteNode(12345); // Should not throw
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes.filter(n => n === 12345)).toHaveLength(1);
  });

  it('removeAutoTracerouteNode - removes specific node', async () => {
    const backend = getBackend();
    if (!backend.available) { console.log(`⚠ Skipped: ${backend.skipReason}`); return; }

    await repo.setAutoTracerouteNodes([100, 200, 300]);
    await repo.removeAutoTracerouteNode(200);
    const nodes = await repo.getAutoTracerouteNodes();
    expect(nodes).not.toContain(200);
    expect(nodes).toHaveLength(2);
  });
}

// --- SQLite Backend ---
describe('AutoTracerouteRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
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

  runAutoTracerouteTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('AutoTracerouteRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for auto-traceroute tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runAutoTracerouteTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('AutoTracerouteRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for auto-traceroute tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  beforeEach(async () => {
    if (!backend.available) return;
    for (const table of ALL_TABLES) {
      await clearTable(backend, table);
    }
  });

  runAutoTracerouteTests(() => backend);
});
