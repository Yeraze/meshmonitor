/**
 * Cross-dialect coverage for the flight-trail repository methods
 * (#5364/#5365 Phase 3): `NodesRepository.listAircraftTrailNodeNums` and
 * `AnalysisRepository.getPositionsForNodes`.
 *
 * Both methods touch only a handful of columns, so the tables below carry
 * just those. PG/MySQL suites own a private database via `isolationKey`
 * (CLAUDE.md Multi-Database: never share fixture tables across suites).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NodesRepository } from './nodes.js';
import { AnalysisRepository, POSITIONS_FOR_NODES_CHUNK } from './analysis.js';
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
  CREATE TABLE nodes (
    nodeNum INTEGER NOT NULL,
    nodeId TEXT NOT NULL,
    likelyAircraft INTEGER,
    aircraftAgedOutAt INTEGER,
    sourceId TEXT NOT NULL,
    PRIMARY KEY (nodeNum, sourceId)
  );
  CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT NOT NULL,
    nodeNum INTEGER NOT NULL,
    telemetryType TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    value REAL NOT NULL,
    createdAt INTEGER NOT NULL,
    sourceId TEXT
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS nodes CASCADE;
  DROP TABLE IF EXISTS telemetry CASCADE;
  CREATE TABLE nodes (
    "nodeNum" BIGINT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "likelyAircraft" BOOLEAN,
    "aircraftAgedOutAt" BIGINT,
    "sourceId" TEXT NOT NULL,
    PRIMARY KEY ("nodeNum", "sourceId")
  );
  CREATE TABLE telemetry (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "telemetryType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "sourceId" TEXT
  );
`;

const MYSQL_CREATE = `
  CREATE TABLE nodes (
    nodeNum BIGINT NOT NULL,
    nodeId VARCHAR(32) NOT NULL,
    likelyAircraft BOOLEAN,
    aircraftAgedOutAt BIGINT,
    sourceId VARCHAR(36) NOT NULL,
    PRIMARY KEY (nodeNum, sourceId)
  );
  CREATE TABLE telemetry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeId VARCHAR(32) NOT NULL,
    nodeNum BIGINT NOT NULL,
    telemetryType VARCHAR(64) NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE NOT NULL,
    createdAt BIGINT NOT NULL,
    sourceId VARCHAR(36)
  );
`;

const SRC_A = 'src-a';
const SRC_B = 'src-b';
/** Above signed 32-bit, to prove BIGINT nodeNums round-trip as numbers. */
const BIG = 0xfeedbeef;

function ident(backend: TestBackend, name: string): string {
  return backend.dbType === 'postgres' ? `"${name}"` : name;
}

function boolLit(backend: TestBackend, v: boolean | null): string {
  if (v === null) return 'NULL';
  if (backend.dbType === 'sqlite') return v ? '1' : '0';
  return v ? 'TRUE' : 'FALSE';
}

async function insertNode(
  backend: TestBackend,
  nodeNum: number,
  sourceId: string,
  likelyAircraft: boolean | null,
  agedOutAt: number | null,
): Promise<void> {
  const cols = ['nodeNum', 'nodeId', 'likelyAircraft', 'aircraftAgedOutAt', 'sourceId'].map((c) => ident(backend, c));
  await backend.exec(
    `INSERT INTO nodes (${cols.join(',')}) VALUES (${nodeNum}, '!${nodeNum.toString(16)}', ${boolLit(backend, likelyAircraft)}, ${agedOutAt ?? 'NULL'}, '${sourceId}')`,
  );
}

async function insertFix(
  backend: TestBackend,
  nodeNum: number,
  sourceId: string,
  ts: number,
  lat: number,
  lon: number,
  alt: number | null,
): Promise<void> {
  const cols = ['nodeId', 'nodeNum', 'telemetryType', 'timestamp', 'value', 'createdAt', 'sourceId'].map((c) =>
    ident(backend, c),
  );
  const rows: Array<[string, number]> = [['latitude', lat], ['longitude', lon]];
  if (alt !== null) rows.push(['altitude', alt]);
  for (const [type, value] of rows) {
    await backend.exec(
      `INSERT INTO telemetry (${cols.join(',')}) VALUES ('!${nodeNum.toString(16)}', ${nodeNum}, '${type}', ${ts}, ${value}, ${ts}, '${sourceId}')`,
    );
  }
}

function runTrailRepoTests(getBackend: () => TestBackend) {
  it('listAircraftTrailNodeNums returns flagged and aged-out nodes, scoped by source', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await insertNode(backend, 1, SRC_A, true, null); // flagged
    await insertNode(backend, 2, SRC_A, false, 1_700_000_000_000); // aged out (flag since cleared)
    await insertNode(backend, 3, SRC_A, false, null); // ground
    await insertNode(backend, 4, SRC_A, null, null); // unknown
    await insertNode(backend, BIG, SRC_A, true, null); // flagged, BIGINT
    await insertNode(backend, 1, SRC_B, true, null); // same nodeNum, other source

    const onlyA = await repo.listAircraftTrailNodeNums([SRC_A]);
    const keys = onlyA.map((p) => `${p.sourceId}:${p.nodeNum}`).sort();
    expect(keys).toEqual([`${SRC_A}:1`, `${SRC_A}:2`, `${SRC_A}:${BIG}`].sort());
    for (const p of onlyA) expect(typeof p.nodeNum).toBe('number');

    const both = await repo.listAircraftTrailNodeNums([SRC_A, SRC_B]);
    expect(both).toHaveLength(4);
    expect(await repo.listAircraftTrailNodeNums([])).toEqual([]);
  });

  it('getPositionsForNodes pivots lat/lon/alt, filters by node, source and time, ascending', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const t0 = 1_700_000_000_000;
    await insertFix(backend, BIG, SRC_A, t0 + 2000, 30.2, -80.2, 9100);
    await insertFix(backend, BIG, SRC_A, t0 + 1000, 30.1, -80.1, null); // no altitude
    await insertFix(backend, BIG, SRC_A, t0 - 5000, 29.0, -79.0, 9000); // before sinceMs
    await insertFix(backend, BIG, SRC_A, t0 + 3000, 0, 0, 0); // Null Island
    await insertFix(backend, BIG, SRC_B, t0 + 1500, 10, 20, 100); // other source, not listed
    await insertFix(backend, 7, SRC_A, t0 + 1500, 1, 2, 3); // other node, not asked for

    const rows = await repo.getPositionsForNodes({ sourceIds: [SRC_A], nodeNums: [BIG], sinceMs: t0 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ nodeNum: BIG, sourceId: SRC_A, latitude: 30.1, longitude: -80.1, altitude: null });
    expect(rows[1]).toMatchObject({ nodeNum: BIG, sourceId: SRC_A, latitude: 30.2, longitude: -80.2, altitude: 9100 });
    expect(rows[0].timestamp).toBe(t0 + 1000);
    expect(typeof rows[0].nodeNum).toBe('number');

    expect(await repo.getPositionsForNodes({ sourceIds: [], nodeNums: [BIG], sinceMs: 0 })).toEqual([]);
    expect(await repo.getPositionsForNodes({ sourceIds: [SRC_A], nodeNums: [], sinceMs: 0 })).toEqual([]);
  });

  it('getPositionsForNodes chunks a nodeNum list longer than one IN() batch', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new AnalysisRepository(backend.drizzleDb, backend.dbType);
    const t0 = 1_700_000_000_000;
    // The real node sits in the SECOND chunk.
    const filler = Array.from({ length: POSITIONS_FOR_NODES_CHUNK }, (_, i) => 100_000 + i);
    await insertFix(backend, 42, SRC_A, t0, 1.5, 2.5, null);

    const rows = await repo.getPositionsForNodes({ sourceIds: [SRC_A], nodeNums: [...filler, 42], sinceMs: 0 });
    expect(rows.map((r) => r.nodeNum)).toEqual([42]);
  });
}

describe('Aircraft trail repository methods - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
    await clearTable(backend, 'telemetry');
  });
  runTrailRepoTests(() => backend);
});

describe.skipIf(!postgresAvailable)('Aircraft trail repository methods - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'aircraft_trails');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
    await clearTable(backend, 'telemetry');
  });
  runTrailRepoTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('Aircraft trail repository methods - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'aircraft_trails');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
    await clearTable(backend, 'telemetry');
  });
  runTrailRepoTests(() => backend);
});
