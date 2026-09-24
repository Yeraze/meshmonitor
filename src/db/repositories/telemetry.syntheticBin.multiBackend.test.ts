/**
 * Cross-dialect coverage for synthetic-bin idempotency (#5101 Phase 3 WP1) —
 * the property the transport-traffic writer (WP3) leans on for invariant I1
 * ("never write a bin's telemetry rows before the bin closes" is safe to
 * violate accidentally, because a second write of the same bin is a no-op).
 *
 * `TelemetryRepository.insertTelemetry` uses `insertIgnore`, which relies on
 * the migration 032 unique index `(sourceId, nodeNum, packetId, telemetryType)
 * WHERE packetId IS NOT NULL` (a plain, non-partial unique index on MySQL,
 * since MySQL has no partial index support — see 032's dialect notes).
 * `buildTransportSeriesRows` uses the bin index as `packetId`, so re-writing a
 * bin is exactly this scenario. This test proves "first write wins" and that
 * the same bin index on a DIFFERENT sourceId is NOT deduped against — the
 * index is scoped per source, matching every other per-source invariant in
 * this codebase.
 *
 * DDL is hand-written per dialect, matching the convention in
 * `telemetry.favoriteRetention.multiBackend.test.ts`, plus the `packetId`
 * column and the migration 032 unique index reproduced verbatim per dialect.
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
import type { DbTelemetry } from '../types.js';

const INDEX_NAME = 'telemetry_source_packet_type_uniq';

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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
    ON telemetry(sourceId, nodeNum, packetId, telemetryType)
    WHERE packetId IS NOT NULL
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
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
    ON telemetry("sourceId", "nodeNum", "packetId", "telemetryType")
    WHERE "packetId" IS NOT NULL
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
  );
  CREATE UNIQUE INDEX \`${INDEX_NAME}\`
    ON telemetry(sourceId, nodeNum, packetId, telemetryType)
`;

const NODE = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;
const NOW = 1_760_000_000_000;
const BIN_END_MS = 1_760_000_300_000;
const BIN_INDEX = Math.floor(BIN_END_MS / (5 * 60 * 1000));

function makeRow(overrides: Partial<DbTelemetry> = {}): DbTelemetry {
  return {
    nodeId: NODE,
    nodeNum: NODE_NUM,
    telemetryType: 'systemNodesHeardRf',
    timestamp: BIN_END_MS,
    value: 3,
    createdAt: NOW,
    packetId: BIN_INDEX,
    ...overrides,
  };
}

/** Behaviours that must hold identically on every dialect. */
function runSyntheticBinTests(getBackend: () => TestBackend) {
  it('the same bin (sourceId, nodeNum, packetId, telemetryType) inserted twice leaves one row, and the first value wins', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);

    const first = await repo.insertTelemetry(makeRow({ value: 3 }), 'src-a');
    const second = await repo.insertTelemetry(makeRow({ value: 99 }), 'src-a'); // re-write attempt with a different value

    expect(first).toBe(true);
    expect(second).toBe(false);

    const rows = await repo.getTelemetryByNode(NODE, 100, undefined, undefined, 0, undefined, 'src-a');
    const matching = rows.filter(
      (r) => r.telemetryType === 'systemNodesHeardRf' && r.packetId === BIN_INDEX,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].value).toBe(3); // first write wins, not 99
  });

  it('a different sourceId with the same packetId still inserts (index is scoped per source)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);

    const a = await repo.insertTelemetry(makeRow({ value: 3 }), 'src-a');
    const b = await repo.insertTelemetry(makeRow({ value: 5 }), 'src-b');

    expect(a).toBe(true);
    expect(b).toBe(true);

    const bRows = await repo.getTelemetryByNode(NODE, 100, undefined, undefined, 0, undefined, 'src-b');
    const matching = bRows.filter(
      (r) => r.telemetryType === 'systemNodesHeardRf' && r.packetId === BIN_INDEX,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].value).toBe(5);
  });

  it('a different telemetryType with the same (sourceId, nodeNum, packetId) still inserts (all 6 bin rows coexist)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);

    const types = [
      'systemNodesHeardRf', 'systemNodesHeardUdp', 'systemNodesHeardMqtt',
      'systemPacketsRxRf', 'systemPacketsRxUdp', 'systemPacketsRxMqtt',
    ];
    for (const telemetryType of types) {
      const inserted = await repo.insertTelemetry(makeRow({ telemetryType, value: 1 }), 'src-a');
      expect(inserted).toBe(true);
    }

    const rows = await repo.getTelemetryByNode(NODE, 100, undefined, undefined, 0, undefined, 'src-a');
    const matching = rows.filter((r) => r.packetId === BIN_INDEX);
    expect(matching).toHaveLength(6);
  });

  it('a different packetId (a later bin) always inserts, never suppressed by an earlier bin', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);

    const first = await repo.insertTelemetry(makeRow({ packetId: BIN_INDEX, value: 3 }), 'src-a');
    const later = await repo.insertTelemetry(
      makeRow({ packetId: BIN_INDEX + 1, timestamp: BIN_END_MS + 300_000, value: 4 }),
      'src-a',
    );

    expect(first).toBe(true);
    expect(later).toBe(true);

    const rows = await repo.getTelemetryByNode(NODE, 100, undefined, undefined, 0, undefined, 'src-a');
    expect(rows.filter((r) => r.telemetryType === 'systemNodesHeardRf')).toHaveLength(2);
  });

  it('rows with a NULL packetId are never deduped against each other', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);

    const a = await repo.insertTelemetry(makeRow({ packetId: null, value: 1 }), 'src-a');
    const b = await repo.insertTelemetry(makeRow({ packetId: null, value: 2 }), 'src-a');

    expect(a).toBe(true);
    expect(b).toBe(true);

    const rows = await repo.getTelemetryByNode(NODE, 100, undefined, undefined, 0, undefined, 'src-a');
    expect(rows.filter((r) => r.telemetryType === 'systemNodesHeardRf')).toHaveLength(2);
  });
}

describe('TelemetryRepository synthetic-bin idempotency - SQLite Backend', () => {
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
  runSyntheticBinTests(() => backend);
});

describe.skipIf(!postgresAvailable)('TelemetryRepository synthetic-bin idempotency - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'telemetry_synth_bin');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runSyntheticBinTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('TelemetryRepository synthetic-bin idempotency - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'telemetry_synth_bin');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'telemetry');
  });
  runSyntheticBinTests(() => backend);
});
