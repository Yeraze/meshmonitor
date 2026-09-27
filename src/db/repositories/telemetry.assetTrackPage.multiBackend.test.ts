/**
 * Cross-dialect coverage for `getPositionRowsForNodeNumPage` (#5354, Asset
 * Tracking Phase 2): the paged, oldest-first read that feeds the asset track.
 *
 * What must hold on every backend:
 *  - only position types, only the node, only the given sources, only since `sinceMs`;
 *  - `(timestamp, id)` order, and a cursor that resumes exactly after the
 *    last row even when a page ends inside one timestamp;
 *  - a nodeNum above the signed 32-bit range round-trips as a number.
 *
 * Each backend owns an isolated database (CLAUDE.md Multi-Database).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TelemetryRepository, type PositionTelemetryPageRow } from './telemetry.js';
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
    sourceId TEXT,
    rxSnr REAL,
    hopStart INTEGER,
    hopLimit INTEGER
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
    "sourceId" TEXT,
    "rxSnr" DOUBLE PRECISION,
    "hopStart" INTEGER,
    "hopLimit" INTEGER
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
    sourceId VARCHAR(36),
    rxSnr DOUBLE,
    hopStart INT,
    hopLimit INT
  )
`;

const NOW = 1_760_000_000_000;
const MIN = 60 * 1000;

/** Tracked asset — above the signed 32-bit range on purpose. */
const ASSET = '!fedcba98';
const ASSET_NUM = 0xfedcba98;
const OTHER = '!aabbccdd';
const OTHER_NUM = 0xaabbccdd;

type Row = [nodeId: string, nodeNum: number, type: string, ts: number, value: number, sourceId: string | null, rxSnr?: number];

async function insertRows(backend: TestBackend, rows: Row[]): Promise<void> {
  const q = backend.dbType === 'postgres' ? (c: string) => `"${c}"` : (c: string) => c;
  for (const [nodeId, nodeNum, type, ts, value, sourceId, rxSnr] of rows) {
    await backend.exec(
      `INSERT INTO telemetry (${q('nodeId')},${q('nodeNum')},${q('telemetryType')},timestamp,value,${q('createdAt')},${q('sourceId')},${q('rxSnr')},${q('hopStart')},${q('hopLimit')}) ` +
        `VALUES ('${nodeId}',${nodeNum},'${type}',${ts},${value},${ts},${sourceId === null ? 'NULL' : `'${sourceId}'`},` +
        `${rxSnr === undefined ? 'NULL' : rxSnr},${rxSnr === undefined ? 'NULL' : 3},${rxSnr === undefined ? 'NULL' : 3})`,
    );
  }
}

async function readAll(
  repo: TelemetryRepository,
  opts: { sourceIds: string[]; sinceMs: number; limit: number },
): Promise<{ rows: PositionTelemetryPageRow[]; pages: number }> {
  const rows: PositionTelemetryPageRow[] = [];
  let afterTs: number | undefined;
  let afterId: number | undefined;
  let pages = 0;
  for (;;) {
    const page = await repo.getPositionRowsForNodeNumPage({ nodeNum: ASSET_NUM, ...opts, afterTs, afterId });
    pages++;
    rows.push(...page);
    if (page.length < opts.limit) break;
    afterTs = page[page.length - 1].timestamp;
    afterId = page[page.length - 1].id;
    if (pages > 100) throw new Error('runaway paging');
  }
  return { rows, pages };
}

function runPageTests(getBackend: () => TestBackend) {
  it('reads only position rows for the node, its sources, and the window', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'latitude', NOW - 10 * MIN, 40.1, 'src-a', 7.5],
      [ASSET, ASSET_NUM, 'longitude', NOW - 10 * MIN, -75.1, 'src-a', 7.5],
      [ASSET, ASSET_NUM, 'altitude', NOW - 10 * MIN, 120, 'src-a'],
      [ASSET, ASSET_NUM, 'batteryLevel', NOW - 10 * MIN, 80, 'src-a'], // not position
      [ASSET, ASSET_NUM, 'latitude', NOW - 9 * MIN, 40.2, 'src-c'], // other source
      [ASSET, ASSET_NUM, 'latitude', NOW - 100 * MIN, 40.0, 'src-a'], // before window
      [OTHER, OTHER_NUM, 'latitude', NOW - 5 * MIN, 41, 'src-a'], // other node
      [ASSET, ASSET_NUM, 'ground_speed', NOW - 5 * MIN, 12, 'src-b'],
    ]);
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const rows = await repo.getPositionRowsForNodeNumPage({
      nodeNum: ASSET_NUM, sourceIds: ['src-a', 'src-b'], sinceMs: NOW - 60 * MIN, limit: 100,
    });
    expect(rows.map((r) => [r.telemetryType, r.sourceId, r.value])).toEqual([
      ['latitude', 'src-a', 40.1],
      ['longitude', 'src-a', -75.1],
      ['altitude', 'src-a', 120],
      ['ground_speed', 'src-b', 12],
    ]);
    expect(typeof rows[0].timestamp).toBe('number');
    expect(typeof rows[0].id).toBe('number');
    expect(rows[0].rxSnr).toBe(7.5);
    expect(rows[0].hopStart).toBe(3);
    expect(rows[2].rxSnr).toBeNull();
  });

  it('reads nothing for an empty source list', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [[ASSET, ASSET_NUM, 'latitude', NOW, 40, 'src-a']]);
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    expect(await repo.getPositionRowsForNodeNumPage({ nodeNum: ASSET_NUM, sourceIds: [], sinceMs: 0, limit: 10 })).toEqual([]);
  });

  it('pages oldest first without skipping or repeating rows across a shared timestamp', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    // 7 fixes x 2 sources x lat/lon = 28 rows; each timestamp has 4 rows, so
    // a page of 3 always ends inside a timestamp.
    const rows: Row[] = [];
    for (let i = 0; i < 7; i++) {
      for (const src of ['src-a', 'src-b']) {
        rows.push([ASSET, ASSET_NUM, 'latitude', NOW - (7 - i) * MIN, 40 + i, src]);
        rows.push([ASSET, ASSET_NUM, 'longitude', NOW - (7 - i) * MIN, -75 - i, src]);
      }
    }
    await insertRows(backend, rows);
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const { rows: read, pages } = await readAll(repo, { sourceIds: ['src-a', 'src-b'], sinceMs: 0, limit: 3 });
    expect(pages).toBeGreaterThan(9);
    expect(read).toHaveLength(28);
    expect(new Set(read.map((r) => r.id)).size).toBe(28);
    for (let i = 1; i < read.length; i++) {
      const prev = read[i - 1];
      const cur = read[i];
      expect(cur.timestamp > prev.timestamp || (cur.timestamp === prev.timestamp && cur.id > prev.id)).toBe(true);
    }
  });

  it('supports a timestamp-only cursor', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'latitude', NOW - 2 * MIN, 40, 'src-a'],
      [ASSET, ASSET_NUM, 'latitude', NOW - 1 * MIN, 41, 'src-a'],
    ]);
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const rows = await repo.getPositionRowsForNodeNumPage({
      nodeNum: ASSET_NUM, sourceIds: ['src-a'], sinceMs: 0, afterTs: NOW - 2 * MIN, limit: 10,
    });
    expect(rows.map((r) => r.value)).toEqual([41]);
  });
}

describe('TelemetryRepository asset track page (#5354) - SQLite Backend', () => {
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
  runPageTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository asset track page (#5354) - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_tel_asset_track');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runPageTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository asset track page (#5354) - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_tel_asset_track');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runPageTests(() => backend);
});
