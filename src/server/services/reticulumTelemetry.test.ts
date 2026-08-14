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
  reticulumDestinationNodeNum,
  reticulumDestinationNodeId,
  RETICULUM_DEST_BATTERY,
  RETICULUM_DEST_TEMPERATURE,
  RETICULUM_DEST_HUMIDITY,
  RETICULUM_DEST_PRESSURE,
  RETICULUM_DEST_POWER_IN,
  RETICULUM_DEST_POWER_OUT,
  RETICULUM_DEST_CPU,
  RETICULUM_DEST_RAM,
  RETICULUM_DEST_NVM,
  RETICULUM_DEST_LINK_RSSI,
  RETICULUM_DEST_LINK_SNR,
  RETICULUM_DEST_LINK_Q,
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

describe('reticulumDestinationNodeNum / reticulumDestinationNodeId', () => {
  const HASH_A = 'a'.repeat(32);
  const HASH_B = 'b'.repeat(32);

  it('is deterministic for the same destination hash', () => {
    expect(reticulumDestinationNodeNum(HASH_A)).toBe(reticulumDestinationNodeNum(HASH_A));
  });

  it('differs across distinct destination hashes (no accidental collision for these samples)', () => {
    expect(reticulumDestinationNodeNum(HASH_A)).not.toBe(reticulumDestinationNodeNum(HASH_B));
  });

  it('differs from an interface-derived nodeNum for the "same" raw string (namespaced by prefix)', () => {
    // reticulumInterfaceNodeNum hashes "if:<name>"; reticulumDestinationNodeNum
    // hashes "dest:<hash>" — using the same raw string for both must not
    // collide, since the two synthetic identity spaces are namespaced by
    // their crc32 input prefix, not just the caller-supplied string.
    expect(reticulumDestinationNodeNum(HASH_A)).not.toBe(reticulumInterfaceNodeNum(HASH_A));
  });

  it('is always a non-negative 31-bit integer', () => {
    const n = reticulumDestinationNodeNum(HASH_A);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0x7fffffff);
  });

  it('returns 0 for an empty destination hash', () => {
    expect(reticulumDestinationNodeNum('')).toBe(0);
  });

  it('reticulumDestinationNodeId namespaces with rns:dest: so it cannot collide with rns:iface:/Meshtastic/MeshCore node ids', () => {
    expect(reticulumDestinationNodeId(HASH_A)).toBe(`rns:dest:${HASH_A}`);
    expect(reticulumDestinationNodeId(HASH_A)).not.toBe(reticulumInterfaceNodeId(HASH_A));
  });
});

describe('rns_* telemetryType constants (Phase 3 §2.A/§3 pinned SID subset)', () => {
  it('are all distinct, rns_-prefixed values', () => {
    const values = [
      RETICULUM_DEST_BATTERY,
      RETICULUM_DEST_TEMPERATURE,
      RETICULUM_DEST_HUMIDITY,
      RETICULUM_DEST_PRESSURE,
      RETICULUM_DEST_POWER_IN,
      RETICULUM_DEST_POWER_OUT,
      RETICULUM_DEST_CPU,
      RETICULUM_DEST_RAM,
      RETICULUM_DEST_NVM,
      RETICULUM_DEST_LINK_RSSI,
      RETICULUM_DEST_LINK_SNR,
      RETICULUM_DEST_LINK_Q,
    ];
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^rns_/);
  });

  it('match the pinned wire names from the build spec', () => {
    expect(RETICULUM_DEST_BATTERY).toBe('rns_battery');
    expect(RETICULUM_DEST_TEMPERATURE).toBe('rns_temperature');
    expect(RETICULUM_DEST_HUMIDITY).toBe('rns_humidity');
    expect(RETICULUM_DEST_PRESSURE).toBe('rns_pressure');
    expect(RETICULUM_DEST_POWER_IN).toBe('rns_power_in');
    expect(RETICULUM_DEST_POWER_OUT).toBe('rns_power_out');
    expect(RETICULUM_DEST_CPU).toBe('rns_cpu');
    expect(RETICULUM_DEST_RAM).toBe('rns_ram');
    expect(RETICULUM_DEST_NVM).toBe('rns_nvm');
    expect(RETICULUM_DEST_LINK_RSSI).toBe('rns_link_rssi');
    expect(RETICULUM_DEST_LINK_SNR).toBe('rns_link_snr');
    expect(RETICULUM_DEST_LINK_Q).toBe('rns_link_q');
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
const DEST_HASH = 'c'.repeat(32);

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

  it('insertTelemetryBatch with the rns:dest-derived nodeNum + reticulum sourceId inserts and reads back (Phase 3)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const repo = new TelemetryRepository(backend.drizzleDb, backend.dbType);
    const nodeNum = reticulumDestinationNodeNum(DEST_HASH);
    const nodeId = reticulumDestinationNodeId(DEST_HASH);
    const now = Date.now();

    const rows: DbTelemetry[] = [
      { nodeId, nodeNum, telemetryType: RETICULUM_DEST_BATTERY, timestamp: now, value: 87, createdAt: now },
      { nodeId, nodeNum, telemetryType: RETICULUM_DEST_TEMPERATURE, timestamp: now, value: 21.5, createdAt: now },
    ];

    const inserted = await repo.insertTelemetryBatch(rows, RETICULUM_SOURCE_ID);
    expect(inserted).toBe(2);

    const battBack = await repo.getTelemetryByNode(nodeId, 10, undefined, undefined, 0, RETICULUM_DEST_BATTERY, RETICULUM_SOURCE_ID);
    expect(battBack).toHaveLength(1);
    expect(battBack[0].nodeNum).toBe(nodeNum);
    expect(battBack[0].value).toBeCloseTo(87);

    const tempBack = await repo.getTelemetryByNode(nodeId, 10, undefined, undefined, 0, RETICULUM_DEST_TEMPERATURE, RETICULUM_SOURCE_ID);
    expect(tempBack).toHaveLength(1);
    expect(tempBack[0].value).toBeCloseTo(21.5);
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
