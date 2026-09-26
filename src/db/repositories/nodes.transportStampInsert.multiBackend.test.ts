/**
 * #5101 Phase 3 WP3 EXTRA — `upsertNode`'s INSERT branch must carry
 * `transportLast{Rf,Mqtt,Udp}` forward on a brand-new node's very first row.
 *
 * `meshtasticManager.ts`'s per-packet handler (~6407) is the ONLY place that
 * stamps these columns, and it runs for every heard packet — including a
 * node's first-ever sighting, when `upsertNode` has no existing row and takes
 * the INSERT branch. Before this fix, both the plain INSERT values and the
 * `ON CONFLICT DO UPDATE` values omitted the three columns entirely, so a
 * brand-new node's first transport stamp was silently dropped and only
 * recorded starting on its SECOND packet (the UPDATE branch, which has always
 * carried them). That undercounts
 * `NodesRepository.countNodesHeardByTransport` (the "nodes heard" series
 * powering `transportTrafficService`, #5101 P3 WP3) for exactly the bin in
 * which a new node first appears.
 *
 * DDL mirrors `nodes.transportHeard.multiBackend.test.ts` (itself matching
 * `nodes.test.ts`'s POSTGRES_CREATE / MYSQL_CREATE) so `upsertNode` sees the
 * real column set on every dialect. Uses its own isolated PG/MySQL database
 * (`isolationKey: 'nodes_transport_stamp_insert'`) — a different key than the
 * sibling suite, per the "PG/MySQL fixture races" rule (each multi-backend
 * suite owns its own throwaway database; a shared one races on concurrent
 * CREATE/DROP TABLE).
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

const SOURCE = 'src-a';

/** Behaviours that must hold identically on every dialect. */
function runTransportStampInsertTests(getBackend: () => TestBackend) {
  it('a brand-new node persists its transport stamp on the very first upsertNode call (INSERT branch)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);

    // Single upsertNode call, exactly like meshtasticManager.ts's per-packet
    // handler for a node with no existing row: nodeId/nodeNum plus one
    // transport stamp, in one shot — no prior "bare" insert.
    await repo.upsertNode(
      { nodeNum: 200, nodeId: '!000000c8', longName: 'Node !000000c8', transportLastRf: 1_760_000_100 },
      SOURCE,
    );

    const node = await repo.getNode(200, SOURCE);
    expect(node?.transportLastRf).toBe(1_760_000_100);
    expect(typeof node?.transportLastRf).toBe('number');
  });

  it('immediately counts toward countNodesHeardByTransport for the bin the node first appeared in', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const fromSec = 1_760_000_000;
    const toSec = fromSec + 300;

    await repo.upsertNode(
      { nodeNum: 201, nodeId: '!000000c9', longName: 'Node !000000c9', transportLastMqtt: fromSec + 50 },
      SOURCE,
    );

    const counts = await repo.countNodesHeardByTransport(SOURCE, fromSec, toSec);
    expect(counts).toEqual({ rf: 0, udp: 0, mqtt: 1 });
  });

  it('a node created with no transport stamp (e.g. contact-URL import) still has null, not an error', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);

    await repo.upsertNode({ nodeNum: 202, nodeId: '!000000ca', longName: 'Node !000000ca' }, SOURCE);

    const node = await repo.getNode(202, SOURCE);
    expect(node?.transportLastRf).toBeNull();
    expect(node?.transportLastMqtt).toBeNull();
    expect(node?.transportLastUdp).toBeNull();
  });

  it('a later packet on a different transport adds its own stamp without erasing the first (UPDATE branch, regression guard)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const first = 1_760_000_000;
    const second = first + 120;

    await repo.upsertNode(
      { nodeNum: 203, nodeId: '!000000cb', longName: 'Node !000000cb', transportLastRf: first },
      SOURCE,
    );
    await repo.upsertNode({ nodeNum: 203, nodeId: '!000000cb', transportLastUdp: second }, SOURCE);

    const node = await repo.getNode(203, SOURCE);
    expect(node?.transportLastRf).toBe(first);
    expect(node?.transportLastUdp).toBe(second);
  });

  it('handles stamps above 2^31 on the INSERT branch (BIGINT columns on PG/MySQL)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const big = 3_000_000_000; // > INT32 max (2_147_483_647)

    await repo.upsertNode(
      { nodeNum: 204, nodeId: '!000000cc', longName: 'Node !000000cc', transportLastMqtt: big },
      SOURCE,
    );

    const node = await repo.getNode(204, SOURCE);
    expect(node?.transportLastMqtt).toBe(big);
  });
}

describe('NodesRepository.upsertNode — transport stamp on first-seen INSERT (#5101 P3 WP3 EXTRA)', () => {
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
    runTransportStampInsertTests(() => backend);
  });

  describe.skipIf(!postgresAvailable)('PostgreSQL Backend', () => {
    let backend: TestBackend;
    beforeAll(async () => {
      backend = await createPostgresBackend(POSTGRES_CREATE, 'nodes_transport_stamp_insert');
    });
    afterAll(async () => {
      if (backend) await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'nodes');
    });
    runTransportStampInsertTests(() => backend);
  });

  describe.skipIf(!mysqlAvailable)('MySQL Backend', () => {
    let backend: TestBackend;
    beforeAll(async () => {
      backend = await createMysqlBackend(MYSQL_CREATE, 'nodes_transport_stamp_insert');
    });
    afterAll(async () => {
      if (backend) await backend.close();
    });
    beforeEach(async () => {
      await clearTable(backend, 'nodes');
    });
    runTransportStampInsertTests(() => backend);
  });
});
