/**
 * Cross-dialect coverage for source-scoped favorite retention in
 * `TelemetryRepository.deleteOldTelemetryWithFavorites` (issue #5080).
 *
 * The risk here is pure SQL dialect behaviour, not application logic:
 *  - `NOT (… OR …)` over a nullable `sourceId` (three-valued logic differs in
 *    consequence between "row deleted" and "row kept forever").
 *  - Multiple favorite groups, each with its own cutoff, applied in sequence —
 *    MySQL takes the count-then-delete path, SQLite/PostgreSQL use RETURNING.
 *
 * DDL is hand-written per dialect, matching the convention in
 * `telemetry.cadenceAggregates.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelemetryRepository } from './telemetry.js';
import { telemetrySqlite, telemetryPostgres, telemetryMysql } from '../schema/telemetry.js';
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

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const REGULAR_CUTOFF = NOW - 7 * DAY;

const NODE = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;

/** One row: [nodeId, nodeNum, telemetryType, timestamp, sourceId|null]. */
type Row = [string, number, string, number, string | null];

async function insertRows(backend: TestBackend, rows: Row[]): Promise<void> {
  const q = backend.dbType === 'postgres' ? (c: string) => `"${c}"` : (c: string) => c;
  for (const [nodeId, nodeNum, type, ts, sourceId] of rows) {
    await backend.exec(
      `INSERT INTO telemetry (${q('nodeId')},${q('nodeNum')},${q('telemetryType')},timestamp,value,${q('createdAt')},${q('sourceId')}) ` +
        `VALUES ('${nodeId}',${nodeNum},'${type}',${ts},1.0,${ts},${sourceId === null ? 'NULL' : `'${sourceId}'`})`
    );
  }
}

function telemetryTable(backend: TestBackend) {
  if (backend.dbType === 'postgres') return telemetryPostgres;
  if (backend.dbType === 'mysql') return telemetryMysql;
  return telemetrySqlite;
}

async function remaining(
  backend: TestBackend
): Promise<Array<{ type: string; ts: number; sourceId: string | null }>> {
  // Explicit column list: the hand-written DDL above is a subset of the real
  // schema, and a bare `select()` would enumerate every schema column.
  const t = telemetryTable(backend) as any;
  const rows = await backend.drizzleDb
    .select({ telemetryType: t.telemetryType, timestamp: t.timestamp, sourceId: t.sourceId })
    .from(t);
  return (rows as any[]).map((r) => ({
    type: r.telemetryType,
    ts: Number(r.timestamp),
    sourceId: r.sourceId ?? null,
  }));
}

function runFavoriteRetentionTests(getBackend: () => TestBackend) {
  it('keeps a per-source favorite past the regular window and out to its own cutoff', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'], // favorited, within 30d
      [NODE, NODE_NUM, 'batteryLevel', NOW - 40 * DAY, 'src-a'], // favorited, past 30d
      [NODE, NODE_NUM, 'voltage', NOW - 20 * DAY, 'src-a'],      // not favorited
      [NODE, NODE_NUM, 'batteryLevel', NOW - 1 * DAY, 'src-a'],  // recent
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW - 7 * DAY, [
      {
        sourceId: 'src-a',
        nodeId: NODE,
        telemetryType: 'batteryLevel',
        cutoffTimestamp: NOW - 30 * DAY,
      },
    ]);

    expect(result.nonFavoritesDeleted).toBe(1); // voltage
    expect(result.favoritesDeleted).toBe(1); // the 40-day-old battery row

    const rows = await remaining(backend);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === 'batteryLevel')).toBe(true);
    expect(rows.some((r) => r.ts === NOW - 20 * DAY)).toBe(true);
  });

  it('does not let one source\'s favorite protect another source\'s rows', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'], // protected
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-b'], // NOT protected
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW - 7 * DAY, [
      {
        sourceId: 'src-a',
        nodeId: NODE,
        telemetryType: 'batteryLevel',
        cutoffTimestamp: NOW - 30 * DAY,
      },
    ]);

    expect(result.nonFavoritesDeleted).toBe(1);
    const rows = await remaining(backend);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('src-a');
  });

  it('applies a different cutoff per source in one pass', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'], // src-a keeps 90d → survives
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-b'], // src-b keeps 14d → purged
      [NODE, NODE_NUM, 'batteryLevel', NOW - 10 * DAY, 'src-b'], // within 14d → survives
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW - 7 * DAY, [
      { sourceId: 'src-a', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 90 * DAY },
      { sourceId: 'src-b', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 14 * DAY },
    ]);

    expect(result.nonFavoritesDeleted).toBe(0);
    expect(result.favoritesDeleted).toBe(1);

    const rows = await remaining(backend);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.sourceId === 'src-a')).toHaveLength(1);
    expect(rows.filter((r) => r.sourceId === 'src-b')).toHaveLength(1);
  });

  it('does not strand legacy NULL-sourceId rows in the NOT(...) three-valued gap', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, null], // favorited type, legacy row
      [NODE, NODE_NUM, 'voltage', NOW - 20 * DAY, null],      // non-favorited legacy row
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW - 7 * DAY, [
      { sourceId: 'src-a', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 30 * DAY },
    ]);

    // The non-favorited legacy row MUST be deleted — a NULL-propagating
    // `NOT (sourceId = 'src-a' AND …)` would leave it in the table forever.
    expect(result.nonFavoritesDeleted).toBe(1);
    const rows = await remaining(backend);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('batteryLevel');
  });

  it('treats an unscoped (legacy global) favorite as matching every source', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'],
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-b'],
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW - 30 * DAY, [
      { nodeId: NODE, telemetryType: 'batteryLevel' },
    ]);

    expect(result.nonFavoritesDeleted).toBe(0);
    expect(result.favoritesDeleted).toBe(0);
    expect(await remaining(backend)).toHaveLength(2);
  });

  it('never retains a favorite for less time than plain telemetry', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [[NODE, NODE_NUM, 'batteryLevel', NOW - 3 * DAY, 'src-a']]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    // A favorite cutoff NEWER than the regular cutoff is nonsense; it must be
    // clamped rather than purging inside the regular window.
    const result = await repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, NOW, [
      { sourceId: 'src-a', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW },
    ]);

    expect(result.favoritesDeleted).toBe(0);
    expect(await remaining(backend)).toHaveLength(1);
  });
}

describe('TelemetryRepository favorite retention (#5080) - SQLite Backend', () => {
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
  runFavoriteRetentionTests(() => backend);

  // The production SQLite path goes through the sync variant — same semantics,
  // separate code path.
  it('sync variant applies per-source cutoffs identically', async () => {
    await insertRows(backend, [
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'],
      [NODE, NODE_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-b'],
      [NODE, NODE_NUM, 'voltage', NOW - 20 * DAY, 'src-a'],
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = repo.deleteOldTelemetryWithFavoritesSync(REGULAR_CUTOFF, NOW - 7 * DAY, [
      { sourceId: 'src-a', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 90 * DAY },
      { sourceId: 'src-b', nodeId: NODE, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 14 * DAY },
    ]);

    expect(result.nonFavoritesDeleted).toBe(1); // voltage
    expect(result.favoritesDeleted).toBe(1); // src-b past its 14d window

    const rows = await remaining(backend);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('src-a');
  });
});

describe.skipIf(!postgresAvailable)('TelemetryRepository favorite retention (#5080) - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_tel_fav_retention');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runFavoriteRetentionTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository favorite retention (#5080) - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_tel_fav_retention');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runFavoriteRetentionTests(() => backend);
});
