/**
 * Cross-dialect coverage for `AnalysisRepository.getHopCounts`.
 *
 * `analysis.test.ts` constructs the repository with `'sqlite'` in all 15 of
 * its cases, so nothing exercised this query against PostgreSQL or MySQL.
 * That was tolerable while it was a flat `SELECT ... WHERE ... ORDER BY`, but
 * the query now narrows to the newest ANSWERED row per node with a
 * `GROUP BY` + `INNER JOIN` against a subquery — and dialect compatibility is
 * the entire risk of that change. So it is executed here on every backend.
 *
 * The DDL below is hand-written per dialect, matching the convention in
 * `newsCache.test.ts` / `channels.test.ts`: only the SQLite suite builds its
 * schema from the migration registry. Note the PostgreSQL identifiers are
 * quoted (camelCase columns) while MySQL's are bare.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AnalysisRepository } from './analysis.js';
import {
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
  type TestBackend,
} from './test-utils.js';

const SQLITE_CREATE = `
  CREATE TABLE traceroutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromNodeNum INTEGER NOT NULL,
    toNodeNum INTEGER NOT NULL,
    fromNodeId TEXT NOT NULL,
    toNodeId TEXT NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INTEGER,
    packetId INTEGER,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    sourceId TEXT
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS traceroutes CASCADE;
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    route TEXT,
    "routeBack" TEXT,
    "snrTowards" TEXT,
    "snrBack" TEXT,
    "routePositions" TEXT,
    channel INTEGER,
    "packetId" BIGINT,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS traceroutes;
  CREATE TABLE traceroutes (
    id SERIAL PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    routePositions TEXT,
    channel INT,
    packetId BIGINT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(64)
  )
`;

/** Dialect-correct INSERT — PostgreSQL needs quoted camelCase identifiers. */
function insertSql(dbType: string): string {
  const cols = ['fromNodeNum', 'toNodeNum', 'fromNodeId', 'toNodeId', 'sourceId', 'route', 'timestamp', 'createdAt'];
  const quoted = dbType === 'postgres' ? cols.map((c) => `"${c}"`) : cols;
  const placeholders = dbType === 'postgres'
    ? cols.map((_, i) => `$${i + 1}`).join(',')
    : cols.map(() => '?').join(',');
  return `INSERT INTO traceroutes (${quoted.join(',')}) VALUES (${placeholders})`;
}

type Row = [number, number, string, string, string, string | null, number, number];

async function insertRows(backend: TestBackend, rows: Row[]): Promise<void> {
  const sql = insertSql(backend.dbType);
  for (const row of rows) {
    // Values are inlined rather than parameterised because `TestBackend.exec`
    // takes a bare SQL string. Every value here is test-authored, so there is
    // no injection surface; NULL is spelled literally so the pending case is
    // genuinely NULL rather than the string 'null'.
    const literal = sql.replace(/\$\d+|\?/g, () => {
      const v = row.shift() as string | number | null;
      if (v === null) return 'NULL';
      return typeof v === 'number' ? String(v) : `'${v}'`;
    });
    await backend.exec(literal);
  }
}

/**
 * The behaviours that must hold identically on every dialect. Deliberately the
 * same scenarios as the SQLite suite in `analysis.test.ts` — the point is to
 * prove the SQL, not to invent new semantics.
 */
function runHopCountsTests(getBackend: () => TestBackend) {
  const NOW = 1_760_000_000_000;

  it('reports the newest answered traceroute per node', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 99, '!00000001', '!00000063', 'src-a', '[10,20,30]', NOW - 1000, NOW - 1000],
      [1, 99, '!00000001', '!00000063', 'src-a', '[10,20]', NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 99)?.hops).toBe(2);
  });

  it('excludes a pending (NULL route) row and falls back to the answered one', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 99, '!00000001', '!00000063', 'src-a', '[10,20,30]', NOW - 5000, NOW - 5000],
      [1, 99, '!00000001', '!00000063', 'src-a', null, NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 99)?.hops).toBe(3);
  });

  it('omits a node whose only traceroute is pending', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 99, '!00000001', '!00000063', 'src-a', null, NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 99)).toBeUndefined();
  });

  it('still reports a direct neighbour (empty route) as 0 hops', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 77, '!00000001', '!0000004d', 'src-a', '[]', NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 77)?.hops).toBe(0);
  });

  it('groups per (sourceId, nodeNum) rather than collapsing across sources', async () => {
    // The GROUP BY must key on both columns; getting it wrong would let one
    // source's traceroute answer for another's node.
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 99, '!00000001', '!00000063', 'src-a', '[10]', NOW, NOW],
      [1, 99, '!00000001', '!00000063', 'src-b', '[10,20,30,40]', NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a', 'src-b'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 99 && e.sourceId === 'src-a')?.hops).toBe(1);
    expect(r.entries.find((e) => Number(e.nodeNum) === 99 && e.sourceId === 'src-b')?.hops).toBe(4);
  });

  it('returns one entry per node even when two rows tie on the max timestamp', async () => {
    // The join emits both tied rows; the `seen` guard must collapse them.
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 55, '!00000001', '!00000037', 'src-a', '[10]', NOW, NOW],
      [1, 55, '!00000001', '!00000037', 'src-a', '[10,20]', NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.filter((e) => Number(e.nodeNum) === 55)).toHaveLength(1);
  });

  it('restricts to the requested sources', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [1, 99, '!00000001', '!00000063', 'src-a', '[10]', NOW, NOW],
      [1, 42, '!00000001', '!0000002a', 'src-b', '[10,20]', NOW, NOW],
    ]);

    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });

    expect(r.entries.find((e) => Number(e.nodeNum) === 99)).toBeDefined();
    expect(r.entries.find((e) => Number(e.nodeNum) === 42)).toBeUndefined();
  });
}

describe('AnalysisRepository.getHopCounts - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'traceroutes');
  });
  runHopCountsTests(() => backend);
});

describe.skipIf(!postgresAvailable)('AnalysisRepository.getHopCounts - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'traceroutes');
  });
  runHopCountsTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('AnalysisRepository.getHopCounts - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'traceroutes');
  });
  runHopCountsTests(() => backend);
});
