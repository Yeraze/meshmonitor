/**
 * Reticulum interface-history telemetry helper tests (epic #3960, Phase 1a
 * WP1).
 *
 * Two layers:
 *  1. Pure unit tests of the crc32-derived nodeNum/nodeId helpers.
 *  2. The WP1-mandated regression guard: an `insertTelemetryBatch` call using
 *     the derived nodeNum + a reticulum sourceId inserts and reads back on
 *     all three backends (SQLite always; PostgreSQL/MySQL container-gated).
 *     This pins the §7 risk-1 decision (shared `telemetry` table, no
 *     enforced FK) — see RETICULUM_PHASE1A_BUILD_SPEC.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  reticulumInterfaceNodeNum,
  reticulumInterfaceNodeId,
  RETICULUM_IFACE_TX_RATE,
  RETICULUM_IFACE_RX_RATE,
} from './reticulumTelemetry.js';
import { TelemetryRepository } from '../../db/repositories/telemetry.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  postgresAvailable,
  mysqlAvailable,
} from '../../db/repositories/test-utils.js';
import type { DbTelemetry } from '../../db/types.js';

describe('reticulumInterfaceNodeNum / reticulumInterfaceNodeId', () => {
  it('is deterministic for the same interface name', () => {
    expect(reticulumInterfaceNodeNum('TCPClientInterface[a]')).toBe(
      reticulumInterfaceNodeNum('TCPClientInterface[a]'),
    );
  });

  it('differs across distinct interface names (no accidental collision for these samples)', () => {
    const a = reticulumInterfaceNodeNum('TCPClientInterface[rns.example.com]');
    const b = reticulumInterfaceNodeNum('AutoInterface[wlan0]');
    expect(a).not.toBe(b);
  });

  it('is always a non-negative 31-bit integer', () => {
    const n = reticulumInterfaceNodeNum('RNodeInterface[/dev/ttyUSB0]');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0x7fffffff);
  });

  it('returns 0 for an empty interface name', () => {
    expect(reticulumInterfaceNodeNum('')).toBe(0);
  });

  it('reticulumInterfaceNodeId namespaces with rns:iface: so it cannot collide with Meshtastic/MeshCore node ids', () => {
    expect(reticulumInterfaceNodeId('TCPClientInterface[a]')).toBe('rns:iface:TCPClientInterface[a]');
  });
});

// ---------------------------------------------------------------------------
// Insert-and-read-back regression: derived nodeNum + reticulum sourceId
// through the SHARED telemetry table, on all three backends.
// ---------------------------------------------------------------------------

const SQLITE_CREATE = `
  CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nodeId TEXT NOT NULL, nodeNum INTEGER NOT NULL, telemetryType TEXT NOT NULL,
    timestamp INTEGER NOT NULL, value REAL NOT NULL, unit TEXT,
    createdAt INTEGER NOT NULL, packetTimestamp INTEGER, packetId INTEGER,
    channel INTEGER, precisionBits INTEGER, gpsAccuracy REAL,
    rxSnr REAL, hopStart INTEGER, hopLimit INTEGER, sourceId TEXT
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS telemetry CASCADE;
  CREATE TABLE telemetry (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT NOT NULL, "nodeNum" BIGINT NOT NULL, "telemetryType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL, value DOUBLE PRECISION NOT NULL, unit TEXT,
    "createdAt" BIGINT NOT NULL, "packetTimestamp" BIGINT, "packetId" BIGINT,
    channel INTEGER, "precisionBits" INTEGER, "gpsAccuracy" DOUBLE PRECISION,
    "rxSnr" DOUBLE PRECISION, "hopStart" INTEGER, "hopLimit" INTEGER, "sourceId" TEXT
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS telemetry;
  CREATE TABLE telemetry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeId VARCHAR(64) NOT NULL, nodeNum BIGINT NOT NULL, telemetryType VARCHAR(64) NOT NULL,
    timestamp BIGINT NOT NULL, value DOUBLE NOT NULL, unit VARCHAR(32),
    createdAt BIGINT NOT NULL, packetTimestamp BIGINT, packetId BIGINT,
    channel INT, precisionBits INT, gpsAccuracy DOUBLE,
    rxSnr DOUBLE, hopStart INT, hopLimit INT, sourceId VARCHAR(36)
  );
`;

const RETICULUM_SOURCE_ID = 'reticulum-source-1';
const IFACE_NAME = 'TCPClientInterface[rns.example.com]';

function runRegression(getBackend: () => TestBackend) {
  it('insertTelemetryBatch with the derived nodeNum + reticulum sourceId inserts and reads back', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const nodeNum = reticulumInterfaceNodeNum(IFACE_NAME);
    const nodeId = reticulumInterfaceNodeId(IFACE_NAME);
    const now = Date.now();

    const rows: DbTelemetry[] = [
      { nodeId, nodeNum, telemetryType: RETICULUM_IFACE_TX_RATE, timestamp: now, value: 128.5, createdAt: now },
      { nodeId, nodeNum, telemetryType: RETICULUM_IFACE_RX_RATE, timestamp: now, value: 64.25, createdAt: now },
    ];

    const inserted = await repo.insertTelemetryBatch(rows, RETICULUM_SOURCE_ID);
    expect(inserted).toBe(2);

    const txBack = await repo.getTelemetryByNode(nodeId, 10, undefined, undefined, 0, RETICULUM_IFACE_TX_RATE, RETICULUM_SOURCE_ID);
    expect(txBack).toHaveLength(1);
    expect(txBack[0].nodeNum).toBe(nodeNum);
    expect(txBack[0].value).toBeCloseTo(128.5);
    // sourceId is selected at runtime but not part of the typed DbTelemetry
    // interface (matches the existing repository convention).
    expect((txBack[0] as unknown as { sourceId: string }).sourceId).toBe(RETICULUM_SOURCE_ID);

    const rxBack = await repo.getTelemetryByNode(nodeId, 10, undefined, undefined, 0, RETICULUM_IFACE_RX_RATE, RETICULUM_SOURCE_ID);
    expect(rxBack).toHaveLength(1);
    expect(rxBack[0].value).toBeCloseTo(64.25);
  });
}

describe('Reticulum interface telemetry — SQLite (shared table regression)', () => {
  let backend: TestBackend;

  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  runRegression(() => backend);
});

describe.skipIf(!postgresAvailable)('Reticulum interface telemetry — PostgreSQL (shared table regression)', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  runRegression(() => backend);
});

describe.skipIf(!mysqlAvailable)('Reticulum interface telemetry — MySQL (shared table regression)', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
  });

  afterAll(async () => {
    if (backend) await backend.close();
  });

  runRegression(() => backend);
});
