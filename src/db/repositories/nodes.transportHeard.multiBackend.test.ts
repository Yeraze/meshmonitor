/**
 * Cross-dialect coverage for `NodesRepository.countNodesHeardByTransport`
 * (#5101 Phase 3 WP1) — backs the transport-traffic writer's "nodes heard"
 * series (`src/server/services/transportTrafficService.ts`, WP3).
 *
 * DDL below is hand-written per dialect, matching `nodes.test.ts`'s
 * POSTGRES_CREATE / MYSQL_CREATE verbatim (so `upsertNode` — which touches
 * most of the table — behaves identically to the real schema) plus an
 * equivalent SQLite CREATE, same convention as
 * `messages.transportCounts.multiBackend.test.ts`.
 *
 * The risk here is pure SQL dialect behaviour: window-edge inclusivity
 * (`(fromSec, toSec]`), NULL handling in three aggregate SUM(CASE) branches,
 * and BIGINT/NUMERIC aggregate results on PostgreSQL/MySQL (returned as
 * strings/decimals unless coerced back to `number`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NodesRepository } from './nodes.js';
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
  CREATE TABLE nodes (
    nodeNum INTEGER NOT NULL,
    nodeId TEXT NOT NULL,
    longName TEXT,
    shortName TEXT,
    hwModel INTEGER,
    role INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt INTEGER DEFAULT 0,
    transportMechanism INTEGER,
    transportLastRf INTEGER,
    transportLastMqtt INTEGER,
    transportLastUdp INTEGER,
    macaddr TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    batteryLevel INTEGER,
    voltage REAL,
    channelUtilization REAL,
    airUtilTx REAL,
    lastHeard INTEGER,
    snr REAL,
    rssi INTEGER,
    lastTracerouteRequest INTEGER,
    firmwareVersion TEXT,
    channel INTEGER,
    isFavorite INTEGER DEFAULT 0,
    favoriteLocked INTEGER DEFAULT 0,
    isIgnored INTEGER DEFAULT 0,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    lastMeshReceivedKey TEXT,
    hasPKC INTEGER,
    lastPKIPacket INTEGER,
    keyIsLowEntropy INTEGER,
    duplicateKeyDetected INTEGER,
    keyMismatchDetected INTEGER,
    keySecurityIssueDetails TEXT,
    isExcessivePackets INTEGER DEFAULT 0,
    packetRatePerHour INTEGER,
    packetRateLastChecked INTEGER,
    isTimeOffsetIssue INTEGER DEFAULT 0,
    timeOffsetSeconds INTEGER,
    welcomedAt INTEGER,
    nodeStatus TEXT,
    nodeStatusUpdatedAt INTEGER,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy REAL,
    positionHdop REAL,
    positionTimestamp INTEGER,
    positionLocationSource INTEGER,
    positionOverrideEnabled INTEGER DEFAULT 0,
    latitudeOverride REAL,
    longitudeOverride REAL,
    altitudeOverride REAL,
    positionOverrideIsPrivate INTEGER DEFAULT 0,
    hideFromMap INTEGER DEFAULT 0,
    notes TEXT,
    isUnmessagable INTEGER DEFAULT 0,
    isLicensed INTEGER DEFAULT 0,
    hasRemoteAdmin INTEGER DEFAULT 0,
    lastRemoteAdminCheck INTEGER,
    remoteAdminMetadata TEXT,
    lastTimeSync INTEGER,
    isStoreForwardServer INTEGER DEFAULT 0,
    importedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    sourceId TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS nodes CASCADE;
  CREATE TABLE nodes (
    "nodeNum" BIGINT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "hwModel" INTEGER,
    "role" INTEGER,
    "hopsAway" INTEGER,
    "lastMessageHops" INTEGER,
    "viaMqtt" BOOLEAN DEFAULT FALSE,
    "transportMechanism" INTEGER,
    "transportLastRf" BIGINT,
    "transportLastMqtt" BIGINT,
    "transportLastUdp" BIGINT,
    "macaddr" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "altitude" REAL,
    "batteryLevel" INTEGER,
    "voltage" REAL,
    "channelUtilization" REAL,
    "airUtilTx" REAL,
    "lastHeard" BIGINT,
    "snr" REAL,
    "rssi" INTEGER,
    "lastTracerouteRequest" BIGINT,
    "firmwareVersion" TEXT,
    "channel" INTEGER,
    "isFavorite" BOOLEAN DEFAULT FALSE,
    "favoriteLocked" BOOLEAN DEFAULT FALSE,
    "isIgnored" BOOLEAN DEFAULT FALSE,
    "mobile" INTEGER DEFAULT 0,
    "rebootCount" INTEGER,
    "publicKey" TEXT,
    "lastMeshReceivedKey" TEXT,
    "hasPKC" BOOLEAN,
    "lastPKIPacket" BIGINT,
    "keyIsLowEntropy" BOOLEAN,
    "duplicateKeyDetected" BOOLEAN,
    "keyMismatchDetected" BOOLEAN,
    "keySecurityIssueDetails" TEXT,
    "isExcessivePackets" BOOLEAN DEFAULT FALSE,
    "packetRatePerHour" INTEGER,
    "packetRateLastChecked" BIGINT,
    "isTimeOffsetIssue" BOOLEAN DEFAULT FALSE,
    "timeOffsetSeconds" INTEGER,
    "welcomedAt" BIGINT,
    "nodeStatus" TEXT,
    "nodeStatusUpdatedAt" BIGINT,
    "positionChannel" INTEGER,
    "positionPrecisionBits" INTEGER,
    "positionGpsAccuracy" REAL,
    "positionHdop" REAL,
    "positionTimestamp" BIGINT,
    "positionLocationSource" INTEGER,
    "positionOverrideEnabled" BOOLEAN DEFAULT FALSE,
    "latitudeOverride" REAL,
    "longitudeOverride" REAL,
    "altitudeOverride" REAL,
    "positionOverrideIsPrivate" BOOLEAN DEFAULT FALSE,
    "hideFromMap" BOOLEAN DEFAULT FALSE,
    "notes" TEXT,
    "isUnmessagable" BOOLEAN DEFAULT FALSE,
    "isLicensed" BOOLEAN DEFAULT FALSE,
    "hasRemoteAdmin" BOOLEAN DEFAULT FALSE,
    "lastRemoteAdminCheck" BIGINT,
    "remoteAdminMetadata" TEXT,
    "lastTimeSync" BIGINT,
    "isStoreForwardServer" BOOLEAN DEFAULT FALSE,
    "importedAt" BIGINT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "sourceId" TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY ("nodeNum", "sourceId")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS nodes;
  CREATE TABLE nodes (
    nodeNum BIGINT NOT NULL,
    nodeId VARCHAR(255) NOT NULL,
    longName VARCHAR(255),
    shortName VARCHAR(255),
    hwModel INTEGER,
    \`role\` INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt BOOLEAN DEFAULT FALSE,
    transportMechanism INTEGER,
    transportLastRf BIGINT,
    transportLastMqtt BIGINT,
    transportLastUdp BIGINT,
    macaddr VARCHAR(255),
    latitude DOUBLE,
    longitude DOUBLE,
    altitude DOUBLE,
    batteryLevel INTEGER,
    voltage DOUBLE,
    channelUtilization DOUBLE,
    airUtilTx DOUBLE,
    lastHeard BIGINT,
    snr DOUBLE,
    rssi INTEGER,
    lastTracerouteRequest BIGINT,
    firmwareVersion VARCHAR(255),
    channel INTEGER,
    isFavorite BOOLEAN DEFAULT FALSE,
    favoriteLocked BOOLEAN DEFAULT FALSE,
    isIgnored BOOLEAN DEFAULT FALSE,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    lastMeshReceivedKey TEXT,
    hasPKC BOOLEAN,
    lastPKIPacket BIGINT,
    keyIsLowEntropy BOOLEAN,
    duplicateKeyDetected BOOLEAN,
    keyMismatchDetected BOOLEAN,
    keySecurityIssueDetails TEXT,
    isExcessivePackets BOOLEAN DEFAULT FALSE,
    packetRatePerHour INTEGER,
    packetRateLastChecked BIGINT,
    isTimeOffsetIssue BOOLEAN DEFAULT FALSE,
    timeOffsetSeconds INTEGER,
    welcomedAt BIGINT,
    nodeStatus VARCHAR(80),
    nodeStatusUpdatedAt BIGINT,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy DOUBLE,
    positionHdop DOUBLE,
    positionTimestamp BIGINT,
    positionLocationSource INT,
    positionOverrideEnabled BOOLEAN DEFAULT FALSE,
    latitudeOverride DOUBLE,
    longitudeOverride DOUBLE,
    altitudeOverride DOUBLE,
    positionOverrideIsPrivate BOOLEAN DEFAULT FALSE,
    hideFromMap BOOLEAN DEFAULT FALSE,
    notes VARCHAR(2000),
    isUnmessagable BOOLEAN DEFAULT FALSE,
    isLicensed BOOLEAN DEFAULT FALSE,
    hasRemoteAdmin BOOLEAN DEFAULT FALSE,
    lastRemoteAdminCheck BIGINT,
    remoteAdminMetadata TEXT,
    lastTimeSync BIGINT,
    isStoreForwardServer BOOLEAN DEFAULT FALSE,
    importedAt BIGINT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const SOURCE = 'src-a';
const FROM_SEC = 1_760_000_000;
const TO_SEC = FROM_SEC + 300; // 5-minute bin

function makeNode(nodeNum: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    ...overrides,
  };
}

/**
 * `upsertNode`'s INSERT branch does not carry `transportLast*` fields — those
 * are only ever set on the UPDATE branch, matching production: a node's row
 * is created from NodeInfo (no transport stamp yet) and the stamp is applied
 * by a later, separate per-packet write. Mirror that here: insert bare, then
 * a second upsert (now an UPDATE, since the row exists) applies the stamps.
 */
async function seedNode(
  repo: NodesRepository,
  sourceId: string,
  nodeNum: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await repo.upsertNode(makeNode(nodeNum), sourceId);
  if (Object.keys(overrides).length > 0) {
    await repo.upsertNode(makeNode(nodeNum, overrides), sourceId);
  }
}

/** Behaviours that must hold identically on every dialect. */
function runTransportHeardTests(getBackend: () => TestBackend) {
  it('excludes a stamp exactly at fromSec (exclusive lower bound)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 100, { transportLastRf: FROM_SEC });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts.rf).toBe(0);
  });

  it('includes a stamp exactly at toSec (inclusive upper bound)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 101, { transportLastRf: TO_SEC });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts.rf).toBe(1);
  });

  it('excludes a stamp just past toSec', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 102, { transportLastRf: TO_SEC + 1 });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts.rf).toBe(0);
  });

  it('includes a stamp just past fromSec', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 103, { transportLastRf: FROM_SEC + 1 });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts.rf).toBe(1);
  });

  it('is additive: a node heard over two transports in the window counts in both', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const mid = FROM_SEC + 100;
    await seedNode(repo, SOURCE, 110, { transportLastRf: mid, transportLastMqtt: mid + 1 });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts).toEqual({ rf: 1, udp: 0, mqtt: 1 });
  });

  it('NULL stamps never count', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 120); // no transportLast* fields set

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts).toEqual({ rf: 0, udp: 0, mqtt: 0 });
  });

  it('excludeNodeNum removes that node from every class', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const mid = FROM_SEC + 100;
    await seedNode(repo, SOURCE, 130, { transportLastRf: mid });
    await seedNode(repo, SOURCE, 131, { transportLastUdp: mid });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC, 130);
    expect(counts).toEqual({ rf: 0, udp: 1, mqtt: 0 });
  });

  it('handles stamps above 2^31 (BIGINT columns on PG/MySQL)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const big = 3_000_000_000; // > INT32 max (2_147_483_647)
    await seedNode(repo, SOURCE, 140, { transportLastMqtt: big });

    const counts = await repo.countNodesHeardByTransport(SOURCE, big - 100, big + 100);
    expect(counts.mqtt).toBe(1);
  });

  it('returns plain JS numbers, not strings/decimals (PG NUMERIC / MySQL DECIMAL aggregates)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await seedNode(repo, SOURCE, 150, { transportLastRf: FROM_SEC + 1 });

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(typeof counts.rf).toBe('number');
    expect(typeof counts.udp).toBe('number');
    expect(typeof counts.mqtt).toBe('number');
  });

  it('returns all zeros for an empty table', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);

    const counts = await repo.countNodesHeardByTransport(SOURCE, FROM_SEC, TO_SEC);
    expect(counts).toEqual({ rf: 0, udp: 0, mqtt: 0 });
  });
}

describe('NodesRepository.countNodesHeardByTransport - SQLite Backend', () => {
  let backend: TestBackend;
  beforeAll(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
  });
  runTransportHeardTests(() => backend);
});

describe.skipIf(!postgresAvailable)('NodesRepository.countNodesHeardByTransport - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'nodes_transport_heard');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
  });
  runTransportHeardTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('NodesRepository.countNodesHeardByTransport - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'nodes_transport_heard');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
  });
  runTransportHeardTests(() => backend);
});
