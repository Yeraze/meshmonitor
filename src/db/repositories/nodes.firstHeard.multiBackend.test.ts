/**
 * #5390 — `nodes.firstHeard` (Unix SECONDS) is stamped once, from the first
 * plausible `lastHeard` a write carries, and never overwritten. Per-source:
 * each (nodeNum, sourceId) row keeps its own value.
 *
 * DDL mirrors `nodes.transportStampInsert.multiBackend.test.ts` (itself
 * matching `nodes.test.ts`). Own isolated PG/MySQL database
 * (`isolationKey: 'nodes_first_heard'`) per the fixture-race rule.
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
    firstHeard INTEGER,
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
    likelyAircraft INTEGER,
    aircraftBasis TEXT,
    groundElevation REAL,
    heightAboveGround REAL,
    aircraftClassifiedAt INTEGER,
    aircraftAgedOutAt INTEGER,
    aircraftFixedAt INTEGER,
    aircraftFixedLatitude REAL,
    aircraftFixedLongitude REAL,
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
    "firstHeard" BIGINT,
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
    "likelyAircraft" BOOLEAN,
    "aircraftBasis" TEXT,
    "groundElevation" DOUBLE PRECISION,
    "heightAboveGround" DOUBLE PRECISION,
    "aircraftClassifiedAt" BIGINT,
    "aircraftAgedOutAt" BIGINT,
    "aircraftFixedAt" BIGINT,
    "aircraftFixedLatitude" DOUBLE PRECISION,
    "aircraftFixedLongitude" DOUBLE PRECISION,
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
    firstHeard BIGINT,
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
    likelyAircraft BOOLEAN,
    aircraftBasis VARCHAR(8),
    groundElevation DOUBLE,
    heightAboveGround DOUBLE,
    aircraftClassifiedAt BIGINT,
    aircraftAgedOutAt BIGINT,
    aircraftFixedAt BIGINT,
    aircraftFixedLatitude DOUBLE,
    aircraftFixedLongitude DOUBLE,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const T0 = 1_760_000_000; // 2025-10-09, Unix seconds

function runFirstHeardTests(getBackend: () => TestBackend) {
  const repoFor = (b: TestBackend) => new NodesRepository(b.drizzleDb, b.dbType);

  it('stamps firstHeard from lastHeard on the first-seen INSERT', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    await repo.upsertNode({ nodeNum: 300, nodeId: '!0000012c', lastHeard: T0 }, SOURCE_A);
    const node = await repo.getNode(300, SOURCE_A);
    expect(Number(node?.firstHeard)).toBe(T0);
  });

  it('never overwrites firstHeard when later packets move lastHeard forward', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    await repo.upsertNode({ nodeNum: 301, nodeId: '!0000012d', lastHeard: T0 }, SOURCE_A);
    await repo.upsertNode({ nodeNum: 301, nodeId: '!0000012d', lastHeard: T0 + 600 }, SOURCE_A);
    await repo.upsertNode({ nodeNum: 301, nodeId: '!0000012d', lastHeard: T0 + 1200 }, SOURCE_A);
    const node = await repo.getNode(301, SOURCE_A);
    expect(Number(node?.firstHeard)).toBe(T0);
    expect(Number(node?.lastHeard)).toBe(T0 + 1200);
  });

  it('leaves firstHeard null for a row created without a reception, then stamps it on the first one', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    // e.g. a message that only references the node, or a contact-URL import
    await repo.upsertNode({ nodeNum: 302, nodeId: '!0000012e', longName: 'Imported' }, SOURCE_A);
    expect((await repo.getNode(302, SOURCE_A))?.firstHeard ?? null).toBeNull();
    await repo.upsertNode({ nodeNum: 302, nodeId: '!0000012e', lastHeard: T0 + 50 }, SOURCE_A);
    expect(Number((await repo.getNode(302, SOURCE_A))?.firstHeard)).toBe(T0 + 50);
  });

  it('ignores implausible lastHeard values (unsynced clock, far future)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    await repo.upsertNode({ nodeNum: 303, nodeId: '!0000012f', lastHeard: 12_345 }, SOURCE_A);
    expect((await repo.getNode(303, SOURCE_A))?.firstHeard ?? null).toBeNull();
    const future = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
    await repo.upsertNode({ nodeNum: 303, nodeId: '!0000012f', lastHeard: future }, SOURCE_A);
    expect((await repo.getNode(303, SOURCE_A))?.firstHeard ?? null).toBeNull();
  });

  it('keeps firstHeard per source', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    await repo.upsertNode({ nodeNum: 304, nodeId: '!00000130', lastHeard: T0 }, SOURCE_A);
    await repo.upsertNode({ nodeNum: 304, nodeId: '!00000130', lastHeard: T0 + 3600 }, SOURCE_B);
    await repo.upsertNode({ nodeNum: 304, nodeId: '!00000130', lastHeard: T0 + 7200 }, SOURCE_A);
    expect(Number((await repo.getNode(304, SOURCE_A))?.firstHeard)).toBe(T0);
    expect(Number((await repo.getNode(304, SOURCE_B))?.firstHeard)).toBe(T0 + 3600);
  });

  it('ignores a caller-supplied firstHeard on update', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = repoFor(backend);
    await repo.upsertNode({ nodeNum: 305, nodeId: '!00000131', lastHeard: T0 }, SOURCE_A);
    await repo.upsertNode({ nodeNum: 305, nodeId: '!00000131', lastHeard: T0 + 10, firstHeard: T0 + 999 }, SOURCE_A);
    expect(Number((await repo.getNode(305, SOURCE_A))?.firstHeard)).toBe(T0);
  });
}

describe('NodesRepository.upsertNode — firstHeard (#5390)', () => {
  describe('SQLite Backend', () => {
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
    runFirstHeardTests(() => backend);
  });

  describe.skipIf(!postgresAvailable)('PostgreSQL Backend', () => {
    let backend: TestBackend;
    beforeAll(async () => {
      backend = await createPostgresBackend(POSTGRES_CREATE, 'nodes_first_heard');
    });
    afterAll(async () => {
      if (backend) await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'nodes');
    });
    runFirstHeardTests(() => backend);
  });

  describe.skipIf(!mysqlAvailable)('MySQL Backend', () => {
    let backend: TestBackend;
    beforeAll(async () => {
      backend = await createMysqlBackend(MYSQL_CREATE, 'nodes_first_heard');
    });
    afterAll(async () => {
      if (backend) await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'nodes');
    });
    runFirstHeardTests(() => backend);
  });
});
