/**
 * Cross-dialect coverage for the telemetry outlier purge queries (#5333):
 * the raw-series fetch, the id cutoff, distinct node/type listing, and the
 * batched, source+type-fenced delete by id.
 *
 * DDL is hand-written per dialect (the telemetry columns these queries touch),
 * matching telemetry.syntheticBin.multiBackend.test.ts. PG/MySQL suites own a
 * private database via the isolationKey.
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
const NODE_A = { nodeId: '!f00dcafe', nodeNum: 0xf00dcafe };
const NODE_B = { nodeId: '!0000beef', nodeNum: 0x0000beef };
const T0 = 1_760_000_000_000;

function runOutlierQueryTests(getBackend: () => TestBackend) {
  const repo = () => {
    const b = getBackend();
    return new TelemetryRepository(b.drizzleDb, b.dbType);
  };

  const insert = async (
    sourceId: string,
    node: { nodeId: string; nodeNum: number },
    telemetryType: string,
    values: number[],
    t0 = T0,
  ) => {
    const r = repo();
    for (let i = 0; i < values.length; i++) {
      await r.insertTelemetry(
        { ...node, telemetryType, timestamp: t0 + i * 1000, value: values[i], createdAt: t0 },
        sourceId,
      );
    }
  };

  it('max id, node ids and types are scoped to the source (and type / node)', async () => {
    if (!getBackend().available) return;
    await insert('src-a', NODE_A, 'temperature', [1, 2, 3]);
    await insert('src-a', NODE_B, 'temperature', [4]);
    await insert('src-a', NODE_A, 'voltage', [3.7]);
    await insert('src-b', NODE_A, 'humidity', [50]);

    const r = repo();
    const maxA = await r.getMaxTelemetryIdForType('src-a', 'temperature');
    const maxANodeA = await r.getMaxTelemetryIdForType('src-a', 'temperature', NODE_A.nodeId);
    expect(typeof maxA).toBe('number');
    expect(maxANodeA).toBeLessThan(maxA as number); // NODE_B's row came later
    expect(await r.getMaxTelemetryIdForType('src-b', 'temperature')).toBeNull();

    expect(await r.getTelemetryNodeIdsForType('src-a', 'temperature', maxA as number))
      .toEqual([NODE_B.nodeId, NODE_A.nodeId].sort());
    // Cutoff below NODE_B's only row leaves just NODE_A.
    expect(await r.getTelemetryNodeIdsForType('src-a', 'temperature', maxANodeA as number))
      .toEqual([NODE_A.nodeId]);

    expect(await r.getTelemetryTypesForSource('src-a')).toEqual(['temperature', 'voltage']);
    expect(await r.getTelemetryTypesForSource('src-b')).toEqual(['humidity']);
  });

  it('series fetch returns numeric id/value/timestamp oldest first, honouring the cutoff', async () => {
    if (!getBackend().available) return;
    // Insert out of timestamp order to prove the ORDER BY.
    await insert('src-a', NODE_A, 'temperature', [30], T0 + 50_000);
    await insert('src-a', NODE_A, 'temperature', [10, 20]);
    const r = repo();
    const cutoff = (await r.getMaxTelemetryIdForType('src-a', 'temperature')) as number;
    const series = await r.getTelemetrySeriesForOutlierScan('src-a', 'temperature', NODE_A.nodeId, cutoff);
    expect(series.map(p => p.value)).toEqual([10, 20, 30]);
    for (const p of series) {
      expect(typeof p.id).toBe('number');
      expect(typeof p.timestamp).toBe('number');
    }
    expect(series[0].timestamp).toBe(T0);

    await insert('src-a', NODE_A, 'temperature', [40]);
    const again = await r.getTelemetrySeriesForOutlierScan('src-a', 'temperature', NODE_A.nodeId, cutoff);
    expect(again).toHaveLength(3); // the new row sits above the cutoff
  });

  it('deleteTelemetryByIds runs in batches and returns the real count', async () => {
    if (!getBackend().available) return;
    const n = TelemetryRepository.OUTLIER_DELETE_BATCH_SIZE * 2 + 7;
    const r = repo();
    const rows = Array.from({ length: n }, (_, i) => ({
      ...NODE_A,
      telemetryType: 'temperature',
      timestamp: T0 + i,
      value: i,
      createdAt: T0,
    }));
    await r.insertTelemetryBatch(rows, 'src-a');
    const cutoff = (await r.getMaxTelemetryIdForType('src-a', 'temperature')) as number;
    const series = await r.getTelemetrySeriesForOutlierScan('src-a', 'temperature', NODE_A.nodeId, cutoff);
    expect(series).toHaveLength(n);

    const toDelete = series.slice(0, n - 3).map(p => p.id);
    const deleted = await r.deleteTelemetryByIds('src-a', 'temperature', toDelete);
    expect(deleted).toBe(n - 3);
    const left = await r.getTelemetrySeriesForOutlierScan('src-a', 'temperature', NODE_A.nodeId, cutoff);
    expect(left.map(p => p.value)).toEqual([n - 3, n - 2, n - 1]);

    expect(await r.deleteTelemetryByIds('src-a', 'temperature', [])).toBe(0);
  });

  it('deleteTelemetryByIds never removes ids from another source or telemetry type', async () => {
    if (!getBackend().available) return;
    await insert('src-a', NODE_A, 'temperature', [1]);
    await insert('src-b', NODE_A, 'temperature', [2]);
    await insert('src-a', NODE_A, 'voltage', [3]);
    const r = repo();
    const bId = (await r.getMaxTelemetryIdForType('src-b', 'temperature')) as number;
    const vId = (await r.getMaxTelemetryIdForType('src-a', 'voltage')) as number;
    const aId = (await r.getMaxTelemetryIdForType('src-a', 'temperature')) as number;

    // Ask to delete all three ids under (src-a, temperature): only aId qualifies.
    expect(await r.deleteTelemetryByIds('src-a', 'temperature', [aId, bId, vId])).toBe(1);
    expect(await r.getMaxTelemetryIdForType('src-a', 'temperature')).toBeNull();
    expect(await r.getMaxTelemetryIdForType('src-b', 'temperature')).toBe(bId);
    expect(await r.getMaxTelemetryIdForType('src-a', 'voltage')).toBe(vId);
  });
}

describe('TelemetryRepository outlier queries - SQLite Backend', () => {
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
  runOutlierQueryTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository outlier queries - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'telemetry_outliers');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runOutlierQueryTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository outlier queries - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'telemetry_outliers');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runOutlierQueryTests(() => backend);
});
