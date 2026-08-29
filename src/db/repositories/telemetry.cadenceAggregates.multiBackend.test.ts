/**
 * Cross-dialect coverage for `TelemetryRepository.getTelemetryCadenceAggregates`
 * and `getTelemetryTimestamps` (#4964, Mesh Issues Analysis Phase 3 WP2 —
 * Tier C's C2 "over-broadcasting" cadence computation, spec §2.5).
 *
 * `COUNT(DISTINCT timestamp)` / `MIN` / `MAX` / `GROUP BY` are the entire risk
 * of these two queries — dialect compatibility, not application logic — so
 * they are executed here on every backend, matching the precedent in
 * `analysis.hopCounts.multiBackend.test.ts`. The DDL below is hand-written
 * per dialect (same convention): only the SQLite suite builds its schema
 * from the migration registry elsewhere.
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
    sourceId VARCHAR(36)
  )
`;

/** Dialect-correct INSERT — PostgreSQL needs quoted camelCase identifiers. */
function insertSql(dbType: string): string {
  const cols = ['nodeId', 'nodeNum', 'telemetryType', 'timestamp', 'value', 'createdAt', 'sourceId'];
  const quoted = dbType === 'postgres' ? cols.map((c) => `"${c}"`) : cols;
  const placeholders = dbType === 'postgres'
    ? cols.map((_, i) => `$${i + 1}`).join(',')
    : cols.map(() => '?').join(',');
  return `INSERT INTO telemetry (${quoted.join(',')}) VALUES (${placeholders})`;
}

type Row = [string, number, string, number, number, number, string];

async function insertRows(backend: TestBackend, rows: Row[]): Promise<void> {
  const sql = insertSql(backend.dbType);
  for (const row of rows) {
    const literal = sql.replace(/\$\d+|\?/g, () => {
      const v = row.shift() as string | number | null;
      if (v === null) return 'NULL';
      return typeof v === 'number' ? String(v) : `'${v}'`;
    });
    await backend.exec(literal);
  }
}

const NOW = 1_760_000_000_000;

function runCadenceTests(getBackend: () => TestBackend) {
  describe('getTelemetryCadenceAggregates', () => {
    it('dedupes by COUNT(DISTINCT timestamp) when two rows share a timestamp', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW, 30.0, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW, 30.0, NOW, 'src-b'], // same timestamp, different source
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryCadenceAggregates({
        telemetryTypes: ['latitude'],
        sinceMs: NOW - 1000,
        sourceIds: ['src-a', 'src-b'],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].sampleCount).toBe(1);
    });

    it('groups per (nodeNum, telemetryType)', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW - 2000, 30.0, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW - 1000, 30.1, NOW, 'src-a'],
        ['!00000001', 100, 'airUtilTx', NOW - 1000, 5, NOW, 'src-a'],
        ['!00000002', 200, 'latitude', NOW - 1000, 40.0, NOW, 'src-a'],
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryCadenceAggregates({
        telemetryTypes: ['latitude', 'airUtilTx'],
        sinceMs: NOW - 10_000,
        sourceIds: ['src-a'],
      });

      expect(rows).toHaveLength(3);
      const node100Lat = rows.find((r) => Number(r.nodeNum) === 100 && r.telemetryType === 'latitude');
      expect(node100Lat?.sampleCount).toBe(2);
      const node100Air = rows.find((r) => Number(r.nodeNum) === 100 && r.telemetryType === 'airUtilTx');
      expect(node100Air?.sampleCount).toBe(1);
      const node200Lat = rows.find((r) => Number(r.nodeNum) === 200 && r.telemetryType === 'latitude');
      expect(node200Lat?.sampleCount).toBe(1);
    });

    it('honours sinceMs — excludes rows before the cutoff', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW - 100_000, 30.0, NOW, 'src-a'], // too old
        ['!00000001', 100, 'latitude', NOW, 30.1, NOW, 'src-a'],
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryCadenceAggregates({
        telemetryTypes: ['latitude'],
        sinceMs: NOW - 1000,
        sourceIds: ['src-a'],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].sampleCount).toBe(1);
      expect(rows[0].firstTimestamp).toBe(NOW);
      expect(rows[0].lastTimestamp).toBe(NOW);
    });

    it('honours sourceIds — excludes rows from sources outside the list', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW - 1000, 30.0, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW, 30.1, NOW, 'src-b'],
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryCadenceAggregates({
        telemetryTypes: ['latitude'],
        sinceMs: NOW - 10_000,
        sourceIds: ['src-a'],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].sampleCount).toBe(1);
    });

    it('computes firstTimestamp/lastTimestamp across the deduped set', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW - 20_000, 30.0, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW - 10_000, 30.1, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW, 30.2, NOW, 'src-a'],
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryCadenceAggregates({
        telemetryTypes: ['latitude'],
        sinceMs: NOW - 100_000,
        sourceIds: ['src-a'],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].sampleCount).toBe(3);
      expect(rows[0].firstTimestamp).toBe(NOW - 20_000);
      expect(rows[0].lastTimestamp).toBe(NOW);
    });

    it('returns [] for an empty telemetryTypes or sourceIds list rather than issuing a vacuous query', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      expect(await repo.getTelemetryCadenceAggregates({ telemetryTypes: [], sinceMs: 0, sourceIds: ['src-a'] })).toEqual([]);
      expect(await repo.getTelemetryCadenceAggregates({ telemetryTypes: ['latitude'], sinceMs: 0, sourceIds: [] })).toEqual([]);
    });
  });

  describe('getTelemetryTimestamps', () => {
    it('returns only the requested nodes/types/window', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      await insertRows(backend, [
        ['!00000001', 100, 'latitude', NOW - 1000, 30.0, NOW, 'src-a'],
        ['!00000001', 100, 'latitude', NOW, 30.1, NOW, 'src-a'],
        ['!00000001', 100, 'airUtilTx', NOW, 5, NOW, 'src-a'],      // wrong type
        ['!00000002', 200, 'latitude', NOW, 40.0, NOW, 'src-a'],    // wrong node
        ['!00000001', 100, 'latitude', NOW - 100_000, 29.0, NOW, 'src-a'], // too old
        ['!00000001', 100, 'latitude', NOW, 30.2, NOW, 'src-b'],    // wrong source
      ]);

      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      const rows = await repo.getTelemetryTimestamps({
        nodeNums: [100],
        telemetryTypes: ['latitude'],
        sinceMs: NOW - 10_000,
        sourceIds: ['src-a'],
      });

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => Number(r.nodeNum) === 100 && r.telemetryType === 'latitude')).toBe(true);
      expect(rows.map((r) => Number(r.timestamp)).sort((a, b) => a - b)).toEqual([NOW - 1000, NOW]);
    });

    it('returns [] for an empty nodeNums, telemetryTypes, or sourceIds list', async () => {
      const backend = getBackend();
      if (!backend.available) return;
      const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
      expect(await repo.getTelemetryTimestamps({ nodeNums: [], telemetryTypes: ['latitude'], sinceMs: 0, sourceIds: ['src-a'] })).toEqual([]);
      expect(await repo.getTelemetryTimestamps({ nodeNums: [100], telemetryTypes: [], sinceMs: 0, sourceIds: ['src-a'] })).toEqual([]);
      expect(await repo.getTelemetryTimestamps({ nodeNums: [100], telemetryTypes: ['latitude'], sinceMs: 0, sourceIds: [] })).toEqual([]);
    });
  });
}

describe('TelemetryRepository cadence aggregates - SQLite Backend', () => {
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
  runCadenceTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository cadence aggregates - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runCadenceTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository cadence aggregates - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runCadenceTests(() => backend);
});
