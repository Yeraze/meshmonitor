/**
 * Cross-dialect coverage for tracked-asset retention in the telemetry purge
 * (#5354, Asset Tracking Phase 1).
 *
 * `deleteOldTelemetryWithFavorites` (async; the PostgreSQL/MySQL production
 * path) and `deleteOldTelemetryWithFavoritesSync` (the SQLite production path)
 * share one delete plan, but run through different executors — MySQL counts
 * then deletes, SQLite/PostgreSQL use RETURNING, Sync uses `.run().changes`.
 * Every case therefore runs against both variants where the backend allows.
 *
 * Each backend owns an isolated database (CLAUDE.md Multi-Database), so this
 * suite cannot race the #5080 favorite-retention suite over `telemetry`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  TelemetryRepository,
  type AssetRetention,
  type TelemetryFavorite,
  type RetentionPurgeResult,
} from './telemetry.js';
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

/** Tracked asset — above the signed 32-bit range on purpose. */
const ASSET = '!fedcba98';
const ASSET_NUM = 0xfedcba98;
/** Plain node, never an asset. */
const PLAIN = '!aabbccdd';
const PLAIN_NUM = 0xaabbccdd;

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

async function remaining(backend: TestBackend): Promise<Array<{ nodeNum: number; type: string; ageDays: number; sourceId: string | null }>> {
  const t = telemetryTable(backend) as any;
  const rows = await backend.drizzleDb
    .select({ nodeNum: t.nodeNum, telemetryType: t.telemetryType, timestamp: t.timestamp, sourceId: t.sourceId })
    .from(t);
  return (rows as any[])
    .map((r) => ({
      nodeNum: Number(r.nodeNum),
      type: r.telemetryType,
      ageDays: Math.round((NOW - Number(r.timestamp)) / DAY),
      sourceId: r.sourceId ?? null,
    }))
    .sort((a, b) => a.nodeNum - b.nodeNum || a.type.localeCompare(b.type) || a.ageDays - b.ageDays);
}

type Purge = (
  repo: TelemetryRepository,
  favorites: TelemetryFavorite[],
  assets: AssetRetention[],
) => Promise<RetentionPurgeResult>;

const asyncPurge: Purge = (repo, favorites, assets) =>
  repo.deleteOldTelemetryWithFavorites(REGULAR_CUTOFF, REGULAR_CUTOFF, favorites, assets);
const syncPurge: Purge = async (repo, favorites, assets) =>
  repo.deleteOldTelemetryWithFavoritesSync(REGULAR_CUTOFF, REGULAR_CUTOFF, favorites, assets);

function runAssetRetentionTests(getBackend: () => TestBackend, purge: Purge) {
  it('keeps an asset past the 7-day window and purges it past its own window', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'position', NOW - 20 * DAY, 'src-a'], // within 30d asset window
      [ASSET, ASSET_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-b'], // every type, every source
      [ASSET, ASSET_NUM, 'position', NOW - 40 * DAY, 'src-a'], // past 30d
      [ASSET, ASSET_NUM, 'position', NOW - 1 * DAY, 'src-a'], // recent
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(repo, [], [{ nodeNum: ASSET_NUM, cutoff: NOW - 30 * DAY }]);

    expect(result).toEqual({ nonFavoritesDeleted: 0, favoritesDeleted: 0, assetsDeleted: 1 });
    expect((await remaining(backend)).map((r) => [r.type, r.ageDays])).toEqual([
      ['batteryLevel', 20],
      ['position', 1],
      ['position', 20],
    ]);
  });

  it('leaves a non-asset node on the regular window', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [PLAIN, PLAIN_NUM, 'position', NOW - 20 * DAY, 'src-a'], // purged
      [PLAIN, PLAIN_NUM, 'position', NOW - 1 * DAY, 'src-a'], // kept
      [ASSET, ASSET_NUM, 'position', NOW - 20 * DAY, 'src-a'], // kept by asset
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(repo, [], [{ nodeNum: ASSET_NUM, cutoff: NOW - 90 * DAY }]);

    expect(result.nonFavoritesDeleted).toBe(1);
    expect(result.assetsDeleted).toBe(0);
    const rows = await remaining(backend);
    expect(rows.filter((r) => r.nodeNum === PLAIN_NUM).map((r) => r.ageDays)).toEqual([1]);
    expect(rows.filter((r) => r.nodeNum === ASSET_NUM)).toHaveLength(1);
  });

  it('does not clamp an asset window shorter than the regular window', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'position', NOW - 3 * DAY, 'src-a'], // past a 1-day asset window
      [ASSET, ASSET_NUM, 'position', NOW - DAY / 4, 'src-a'], // 6 h old, kept
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(repo, [], [{ nodeNum: ASSET_NUM, cutoff: NOW - 1 * DAY }]);

    expect(result.assetsDeleted).toBe(1);
    expect(await remaining(backend)).toHaveLength(1);
  });

  it('gives a favorite that is also an asset the longer window per row', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      // batteryLevel is favorited for 60d; the asset keeps 30d.
      [ASSET, ASSET_NUM, 'batteryLevel', NOW - 45 * DAY, 'src-a'], // favorite window wins → kept
      [ASSET, ASSET_NUM, 'batteryLevel', NOW - 70 * DAY, 'src-a'], // past both → purged
      [ASSET, ASSET_NUM, 'position', NOW - 20 * DAY, 'src-a'], // asset window → kept
      [ASSET, ASSET_NUM, 'position', NOW - 45 * DAY, 'src-a'], // past asset, not favorited → purged
      // voltage favorited for 14d; the asset window (30d) is longer → kept at 20d.
      [ASSET, ASSET_NUM, 'voltage', NOW - 20 * DAY, 'src-a'],
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(
      repo,
      [
        { sourceId: 'src-a', nodeId: ASSET, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 60 * DAY },
        { sourceId: 'src-a', nodeId: ASSET, telemetryType: 'voltage', cutoffTimestamp: NOW - 14 * DAY },
      ],
      [{ nodeNum: ASSET_NUM, cutoff: NOW - 30 * DAY }],
    );

    expect(result.nonFavoritesDeleted).toBe(0);
    expect(result.favoritesDeleted + result.assetsDeleted).toBe(2);
    expect((await remaining(backend)).map((r) => [r.type, r.ageDays])).toEqual([
      ['batteryLevel', 45],
      ['position', 20],
      ['voltage', 20],
    ]);
  });

  it('still applies favorites to other nodes when assets are present', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [PLAIN, PLAIN_NUM, 'batteryLevel', NOW - 20 * DAY, 'src-a'], // favorited → kept
      [PLAIN, PLAIN_NUM, 'voltage', NOW - 20 * DAY, 'src-a'], // not favorited → purged
      [ASSET, ASSET_NUM, 'voltage', NOW - 20 * DAY, 'src-a'], // asset → kept
    ]);

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(
      repo,
      [{ sourceId: 'src-a', nodeId: PLAIN, telemetryType: 'batteryLevel', cutoffTimestamp: NOW - 30 * DAY }],
      [{ nodeNum: ASSET_NUM, cutoff: NOW - 90 * DAY }],
    );

    expect(result).toEqual({ nonFavoritesDeleted: 1, favoritesDeleted: 0, assetsDeleted: 0 });
    expect(await remaining(backend)).toHaveLength(2);
  });

  it('handles more assets than one IN chunk', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'position', NOW - 20 * DAY, 'src-a'],
      [PLAIN, PLAIN_NUM, 'position', NOW - 20 * DAY, 'src-a'],
    ]);
    // 1,200 assets across three cutoffs; the real asset is in the last chunk.
    const assets: AssetRetention[] = [];
    for (let i = 1; i <= 1200; i++) assets.push({ nodeNum: i, cutoff: NOW - (30 + (i % 3)) * DAY });
    assets.push({ nodeNum: ASSET_NUM, cutoff: NOW - 30 * DAY });

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(repo, [], assets);

    expect(result.nonFavoritesDeleted).toBe(1);
    expect((await remaining(backend)).map((r) => r.nodeNum)).toEqual([ASSET_NUM]);
  });

  it('behaves exactly as before with no favorites and no assets', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    await insertRows(backend, [
      [ASSET, ASSET_NUM, 'position', NOW - 20 * DAY, 'src-a'],
      [ASSET, ASSET_NUM, 'position', NOW - 1 * DAY, 'src-a'],
    ]);
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const result = await purge(repo, [], []);
    expect(result).toEqual({ nonFavoritesDeleted: 1, favoritesDeleted: 0, assetsDeleted: 0 });
  });
}

describe('TelemetryRepository asset retention (#5354) - SQLite Backend', () => {
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
  describe('async variant', () => runAssetRetentionTests(() => backend, asyncPurge));
  // The production SQLite path goes through the Sync variant.
  describe('sync variant', () => runAssetRetentionTests(() => backend, syncPurge));
});

describe.skipIf(!postgresAvailable)('TelemetryRepository asset retention (#5354) - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'r_tel_asset_retention');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runAssetRetentionTests(() => backend, asyncPurge);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository asset retention (#5354) - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'r_tel_asset_retention');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'telemetry');
  });
  runAssetRetentionTests(() => backend, asyncPurge);
});
