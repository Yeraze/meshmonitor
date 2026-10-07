/**
 * Cross-dialect coverage for telemetry reads scoped to a LIST of sources.
 *
 * A route that serves a caller with grants on some sources and not others
 * passes the permitted list down to the query (`sourceId IN (...)`), so rows
 * from a source they may not read never leave the database:
 *
 *   - `getPositionTelemetryByNode(nodeId, ..., sourceIds)` through
 *     `withSourceScope` (position history);
 *   - `getLatestTelemetrySampleForAllNodes(type, sourceIds)`, hand-written SQL
 *     per dialect (the uptime attached to the node list).
 *
 * An empty list is "no source": no rows. DDL is hand-written per dialect, as
 * in telemetry.outliers.multiBackend.test.ts. PG/MySQL suites own a private
 * database via the isolationKey.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelemetryRepository } from './telemetry.js';
import { ALL_SOURCES } from './base.js';
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
const T0 = 1_760_000_000_000;
const SRC_A = 'src-a';
const SRC_B = 'src-b';
const SRC_C = 'src-c';

function runSourceListTests(getBackend: () => TestBackend) {
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

  /** One fix per source, each at its own latitude and time. */
  const seedFixes = async () => {
    await insert(SRC_A, NODE, 'latitude', T0 + 1, 11);
    await insert(SRC_A, NODE, 'longitude', T0 + 1, 11);
    await insert(SRC_B, NODE, 'latitude', T0 + 2, 22);
    await insert(SRC_B, NODE, 'longitude', T0 + 2, 22);
    await insert(SRC_C, NODE, 'latitude', T0 + 3, 33);
    await insert(SRC_C, NODE, 'longitude', T0 + 3, 33);
    // Not a position type, and another node: neither may come back.
    await insert(SRC_A, NODE, 'batteryLevel', T0 + 4, 99);
    await insert(SRC_A, OTHER, 'latitude', T0 + 5, 44);
  };

  const latitudes = (rows: Array<{ telemetryType: string; value: number }>): number[] =>
    rows.filter((r) => r.telemetryType === 'latitude').map((r) => Number(r.value)).sort();

  it('getPositionTelemetryByNode reads only the listed sources', async () => {
    if (!getBackend().available) return;
    await seedFixes();

    expect(latitudes(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, [SRC_A, SRC_C]))).toEqual([11, 33]);
    expect(latitudes(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, [SRC_B]))).toEqual([22]);
  });

  it('getPositionTelemetryByNode returns nothing for an empty list', async () => {
    if (!getBackend().available) return;
    await seedFixes();

    expect(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, [])).toEqual([]);
  });

  it('getPositionTelemetryByNode still reads one source by id and every source with ALL_SOURCES', async () => {
    if (!getBackend().available) return;
    await seedFixes();

    expect(latitudes(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, SRC_B))).toEqual([22]);
    expect(latitudes(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, ALL_SOURCES))).toEqual([11, 22, 33]);
  });

  it('getPositionTelemetryByNode keeps the time window and returns numbers for BIGINT columns', async () => {
    if (!getBackend().available) return;
    await seedFixes();

    const rows = await repo().getPositionTelemetryByNode(NODE.nodeId, 100, T0 + 2, [SRC_A, SRC_B, SRC_C], T0 + 3);
    expect(latitudes(rows)).toEqual([22]);
    expect(rows[0].nodeNum).toBe(NODE.nodeNum);
    expect(typeof rows[0].timestamp).toBe('number');
  });

  it('getPositionTelemetryByNode refuses a list holding an empty id', async () => {
    if (!getBackend().available) return;
    await expect(repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, [SRC_A, ''])).rejects.toThrow(/non-empty string/);
  });

  /** The same node reports a different uptime on each source; C's is the newest. */
  const seedUptime = async () => {
    await insert(SRC_A, NODE, 'uptimeSeconds', T0 + 10, 100);
    await insert(SRC_B, NODE, 'uptimeSeconds', T0 + 20, 200);
    await insert(SRC_C, NODE, 'uptimeSeconds', T0 + 30, 300);
    await insert(SRC_B, OTHER, 'uptimeSeconds', T0 + 40, 400);
  };

  it('getLatestTelemetrySampleForAllNodes takes the newest sample from the listed sources only', async () => {
    if (!getBackend().available) return;
    await seedUptime();

    const ab = await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds', [SRC_A, SRC_B]);
    expect(ab.get(NODE.nodeId)).toEqual({ value: 200, timestamp: T0 + 20 });
    expect(ab.get(OTHER.nodeId)).toEqual({ value: 400, timestamp: T0 + 40 });

    // C holds the newest sample for the node; a caller limited to A must not get it.
    const a = await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds', [SRC_A]);
    expect(a.get(NODE.nodeId)).toEqual({ value: 100, timestamp: T0 + 10 });
    expect(a.has(OTHER.nodeId)).toBe(false);
  });

  it('getLatestTelemetrySampleForAllNodes returns nothing for an empty list', async () => {
    if (!getBackend().available) return;
    await seedUptime();

    expect((await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds', [])).size).toBe(0);
    expect((await repo().getLatestTelemetryValueForAllNodes('uptimeSeconds', [])).size).toBe(0);
  });

  it('getLatestTelemetrySampleForAllNodes still reads one source by id and every source with none', async () => {
    if (!getBackend().available) return;
    await seedUptime();

    expect((await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds', SRC_A)).get(NODE.nodeId)?.value).toBe(100);
    expect((await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds')).get(NODE.nodeId)?.value).toBe(300);
    expect((await repo().getLatestTelemetryValueForAllNodes('uptimeSeconds', [SRC_B, SRC_C])).get(NODE.nodeId)).toBe(300);
  });

  it('a source id is bound as a value, not spliced into the SQL', async () => {
    if (!getBackend().available) return;
    await seedUptime();

    const hostile = "src-a') OR ('1'='1";
    expect((await repo().getLatestTelemetrySampleForAllNodes('uptimeSeconds', [hostile])).size).toBe(0);
    expect(await repo().getPositionTelemetryByNode(NODE.nodeId, 100, undefined, [hostile])).toEqual([]);
  });
}

describe('TelemetryRepository source-list reads - SQLite Backend', () => {
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
  runSourceListTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository source-list reads - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'telemetry_source_list');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runSourceListTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository source-list reads - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'telemetry_source_list');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runSourceListTests(() => backend);
});
