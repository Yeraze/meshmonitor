/**
 * Cross-dialect coverage for the two queries behind the cross-source Telemetry
 * Dashboard (#5896):
 *
 *   - the averaged chart query with a telemetry-type filter (`types IN (...)`),
 *     so the dashboard fetches only favorited series, never every type;
 *   - `getLatestTelemetryPerNodeAndTypeSince`, the one-query "Latest" snapshot
 *     that replaced a per-node, per-type loop.
 *
 * DDL is hand-written per dialect, as in telemetry.sourceList.multiBackend.test.ts.
 * PG/MySQL suites own a private database via the isolationKey.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelemetryRepository } from './telemetry.js';
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
  CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT NOT NULL,
    nodeNum INTEGER NOT NULL,
    telemetryType TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    createdAt INTEGER NOT NULL,
    packetTimestamp INTEGER,
    packetId INTEGER,
    channel INTEGER,
    precisionBits INTEGER,
    gpsAccuracy REAL,
    rxSnr REAL,
    hopStart INTEGER,
    hopLimit INTEGER,
    sourceId TEXT
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS telemetry CASCADE;
  CREATE TABLE telemetry (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "telemetryType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT,
    "createdAt" BIGINT NOT NULL,
    "packetTimestamp" BIGINT,
    "packetId" BIGINT,
    "channel" INTEGER,
    "precisionBits" INTEGER,
    "gpsAccuracy" DOUBLE PRECISION,
    "rxSnr" DOUBLE PRECISION,
    "hopStart" INTEGER,
    "hopLimit" INTEGER,
    "sourceId" TEXT
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS telemetry;
  CREATE TABLE telemetry (
    id SERIAL PRIMARY KEY,
    nodeId VARCHAR(32) NOT NULL,
    nodeNum BIGINT NOT NULL,
    telemetryType VARCHAR(64) NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR(32),
    createdAt BIGINT NOT NULL,
    packetTimestamp BIGINT,
    packetId BIGINT,
    channel INT,
    precisionBits INT,
    gpsAccuracy DOUBLE,
    rxSnr DOUBLE,
    hopStart INT,
    hopLimit INT,
    sourceId VARCHAR(36)
  )
`;

// High-bit nodeNum: unsigned 32-bit, would overflow a signed INT.
const NODE = { nodeId: '!f00dcafe', nodeNum: 0xf00dcafe };
const OTHER = { nodeId: '!0000beef', nodeNum: 0x0000beef };
const NOW = Date.now();
const MIN = 60_000;
const SRC_A = 'src-a';
const SRC_B = 'src-b';

function runDashboardQueryTests(getBackend: () => TestBackend) {
  const repo = () => {
    const b = getBackend();
    return new TelemetryRepository(b.drizzleDb, b.dbType);
  };

  const insert = async (
    sourceId: string,
    node: { nodeId: string; nodeNum: number },
    telemetryType: string,
    timestamp: number,
    value: number,
  ) => {
    await repo().insertTelemetry({ ...node, telemetryType, timestamp, value, createdAt: timestamp }, sourceId);
  };

  /** The averaged query on whichever dialect this backend is. */
  const averaged = async (types?: string[]) => {
    const r = repo();
    const b = getBackend();
    const rows = b.dbType === 'sqlite'
      ? r.getTelemetryByNodeAveragedSqlite(NODE.nodeId, NOW - 60 * MIN, 1, 1, SRC_A, types)
      : await r.getTelemetryByNodeAveragedSql(NODE.nodeId, NOW - 60 * MIN, 1, 1, SRC_A, types);
    return rows;
  };

  it('the averaged query returns only the listed types', async () => {
    await insert(SRC_A, NODE, 'temperature', NOW - 10 * MIN, 20);
    await insert(SRC_A, NODE, 'humidity', NOW - 10 * MIN, 50);
    await insert(SRC_A, NODE, 'batteryLevel', NOW - 10 * MIN, 90);
    // A raw (unaveraged) type goes through the second query; filter it too.
    await insert(SRC_A, NODE, 'numPacketsRx', NOW - 10 * MIN, 7);
    await insert(SRC_B, NODE, 'temperature', NOW - 10 * MIN, 99);

    const all = await averaged();
    expect(new Set(all.map((row) => row.telemetryType))).toEqual(new Set(['temperature', 'humidity', 'batteryLevel', 'numPacketsRx']));

    const some = await averaged(['temperature', 'numPacketsRx']);
    expect(some.map((row) => `${row.telemetryType}=${Number(row.value)}`).sort()).toEqual(['numPacketsRx=7', 'temperature=20']);

    expect(await averaged([])).toEqual([]);
  });

  it('the latest snapshot returns the newest row per node and type on one source, inside the window', async () => {
    await insert(SRC_A, NODE, 'temperature', NOW - 30 * MIN, 20);
    await insert(SRC_A, NODE, 'temperature', NOW - 5 * MIN, 21);
    await insert(SRC_A, NODE, 'batteryLevel', NOW - 90 * MIN, 80); // outside the window
    await insert(SRC_A, OTHER, 'temperature', NOW - 2 * MIN, 30);
    await insert(SRC_B, NODE, 'temperature', NOW - 1 * MIN, 99); // other source
    await insert(SRC_A, NODE, 'humidity', NOW + 2 * 24 * 60 * MIN, 1); // future-dated

    const rows = await repo().getLatestTelemetryPerNodeAndTypeSince(SRC_A, NOW - 60 * MIN);
    expect(rows.map((row) => `${row.nodeId}:${row.telemetryType}=${row.value}`).sort()).toEqual([
      `${NODE.nodeId}:temperature=21`,
      `${OTHER.nodeId}:temperature=30`,
    ].sort());
    const node = rows.find((row) => row.nodeId === NODE.nodeId)!;
    expect(node.nodeNum).toBe(NODE.nodeNum);
    expect(typeof node.timestamp).toBe('number');
    expect(node.timestamp).toBe(NOW - 5 * MIN);
  });

  it('two rows that tie on the newest timestamp collapse to one', async () => {
    await insert(SRC_A, NODE, 'temperature', NOW - 5 * MIN, 21);
    await insert(SRC_A, NODE, 'temperature', NOW - 5 * MIN, 22);
    const rows = await repo().getLatestTelemetryPerNodeAndTypeSince(SRC_A, NOW - 60 * MIN);
    expect(rows).toHaveLength(1);
  });
}

describe('TelemetryRepository dashboard queries - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runDashboardQueryTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository dashboard queries - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'telemetry_dashboard_5896');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runDashboardQueryTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository dashboard queries - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'telemetry_dashboard_5896');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runDashboardQueryTests(() => backend);
});
