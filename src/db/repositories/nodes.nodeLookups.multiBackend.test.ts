/**
 * Cross-dialect coverage for the narrow node lookups the polled routes use
 * instead of loading every node on a source:
 *  - `getNodeChannelsByNodeIds` (unread-counts / first-unread DM sender gate)
 *  - `getNodeNamesByNums` batching (unified messages sender names)
 *
 * DDL is copied verbatim from `nodes.transportHeard.multiBackend.test.ts`
 * (itself matching `nodes.test.ts`), so `upsertNode` behaves as on the real
 * schema. Each PG/MySQL suite owns an isolated database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NodesRepository } from './nodes.js';
import { ALL_SOURCES } from './base.js';
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
    channelLocked INTEGER DEFAULT 0,
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
    aircraftManualMark TEXT,
    aircraftManualMarkAt INTEGER,
    aircraftManualMarkBy INTEGER,
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
    "channelLocked" BOOLEAN DEFAULT FALSE,
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
    "aircraftManualMark" TEXT,
    "aircraftManualMarkAt" BIGINT,
    "aircraftManualMarkBy" INTEGER,
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
    channelLocked BOOLEAN DEFAULT FALSE,
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
    aircraftManualMark VARCHAR(16),
    aircraftManualMarkAt BIGINT,
    aircraftManualMarkBy INT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    sourceId VARCHAR(36) NOT NULL DEFAULT 'default',
    PRIMARY KEY (nodeNum, sourceId)
  )
`;

const SRC_A = 'src-a';
const SRC_B = 'src-b';

const idOf = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

async function seed(
  repo: NodesRepository,
  sourceId: string,
  nodeNum: number,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await repo.upsertNode({ nodeNum, nodeId: idOf(nodeNum), ...fields } as never, sourceId);
}

function runLookupTests(getBackend: () => TestBackend) {
  const repoOf = () => {
    const backend = getBackend();
    return new NodesRepository(backend.drizzleDb, backend.dbType);
  };

  it('getNodeChannelsByNodeIds returns only the asked-for nodes on the named source', async () => {
    const repo = repoOf();
    await seed(repo, SRC_A, 0x0a000001, { channel: 0 });
    await seed(repo, SRC_A, 0x0a000002, { channel: 3 });
    await seed(repo, SRC_A, 0x0a000003); // no channel
    await seed(repo, SRC_A, 0x0a000004, { channel: 1 }); // not asked for
    await seed(repo, SRC_B, 0x0a000002, { channel: 5 }); // other source

    const rows = await repo.getNodeChannelsByNodeIds(
      [idOf(0x0a000001), idOf(0x0a000002), idOf(0x0a000003), '!deadbeef'],
      SRC_A,
    );
    const sorted = [...rows].sort((x, y) => x.nodeId.localeCompare(y.nodeId));
    expect(sorted).toEqual([
      { nodeId: idOf(0x0a000001), channel: 0 },
      { nodeId: idOf(0x0a000002), channel: 3 },
      { nodeId: idOf(0x0a000003), channel: null },
    ]);
    expect(typeof sorted[1].channel).toBe('number');
  });

  it('getNodeChannelsByNodeIds with ALL_SOURCES returns a row per source', async () => {
    const repo = repoOf();
    await seed(repo, SRC_A, 0x0a000002, { channel: 3 });
    await seed(repo, SRC_B, 0x0a000002, { channel: 5 });
    await seed(repo, SRC_B, 0x0b000001, { channel: 0 });

    const rows = await repo.getNodeChannelsByNodeIds([idOf(0x0a000002)], ALL_SOURCES);
    expect(rows.map((r) => r.channel).sort()).toEqual([3, 5]);
  });

  it('getNodeChannelsByNodeIds handles empty input and more ids than one batch', async () => {
    const repo = repoOf();
    expect(await repo.getNodeChannelsByNodeIds([], SRC_A)).toEqual([]);
    await seed(repo, SRC_A, 0x0c000001, { channel: 2 });
    const ids = Array.from({ length: 1200 }, (_, i) => idOf(0x0d000000 + i));
    ids.push(idOf(0x0c000001), idOf(0x0c000001)); // duplicates collapse
    const rows = await repo.getNodeChannelsByNodeIds(ids, SRC_A);
    expect(rows).toEqual([{ nodeId: idOf(0x0c000001), channel: 2 }]);
  });

  it('getNodeChannelsByNodeIds refuses a missing source scope', async () => {
    const repo = repoOf();
    await expect(repo.getNodeChannelsByNodeIds([idOf(1)], undefined as never)).rejects.toThrow();
  });

  it('getNodeNamesByNums resolves names on one source across more nums than one batch', async () => {
    const repo = repoOf();
    await seed(repo, SRC_A, 0x0e000001, { longName: 'Alpha', shortName: 'AL' });
    await seed(repo, SRC_A, 0x0e000002, { longName: null, shortName: 'BR' });
    await seed(repo, SRC_B, 0x0e000003, { longName: 'Other', shortName: 'OT' });

    const nums = Array.from({ length: 1100 }, (_, i) => 0x0f000000 + i);
    nums.push(0x0e000001, 0x0e000002, 0x0e000003, 0x0e000001);
    const names = await repo.getNodeNamesByNums(nums, [SRC_A]);
    expect(names.size).toBe(2);
    expect(names.get(0x0e000001)).toEqual({ longName: 'Alpha', shortName: 'AL' });
    expect(names.get(0x0e000002)?.shortName).toBe('BR');
    expect(names.has(0x0e000003)).toBe(false);
  });
}

describe('NodesRepository narrow lookups - SQLite Backend', () => {
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
  runLookupTests(() => backend);
});

describe.skipIf(!postgresAvailable)('NodesRepository narrow lookups - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'nodes_narrow_lookups');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
  });
  runLookupTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('NodesRepository narrow lookups - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'nodes_narrow_lookups');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    await clearTable(backend, 'nodes');
  });
  runLookupTests(() => backend);
});
