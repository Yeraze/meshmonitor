/**
 * Cross-dialect coverage for the likely-aircraft classification repository
 * methods (#5364/#5365 Phase 1 WP1): `setAircraftClassification`,
 * `getAircraftReclassifyRows`, `getUnclassifiedNodeNumsWithAltitude`, and
 * `clearAircraftClassification`. Also pins that `upsertNode` never clobbers
 * these columns (like `mobile`/`notes`), on both the UPDATE and the
 * INSERT-conflict path.
 *
 * DDL below is hand-written per dialect, matching `nodes.test.ts`'s
 * POSTGRES_CREATE / MYSQL_CREATE (with the migration 175 columns), same
 * convention as the other `nodes.*.multiBackend.test.ts` files.
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

function makeNode(nodeNum: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    ...overrides,
  };
}

/** Behaviours that must hold identically on every dialect. */
function runAircraftTests(getBackend: () => TestBackend) {
  it('setAircraftClassification round-trips all 5 fields (boolean true)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(100, { altitude: 3200 }), SOURCE);

    const now = Date.now();
    await repo.setAircraftClassification(100, SOURCE, {
      likelyAircraft: true,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
      aircraftClassifiedAt: now,
    });

    const node = await repo.getNode(100, SOURCE);
    expect(node?.likelyAircraft).toBe(true);
    expect(node?.aircraftBasis).toBe('agl');
    expect(node?.groundElevation).toBe(200);
    expect(node?.heightAboveGround).toBe(3000);
    expect(Number(node?.aircraftClassifiedAt)).toBe(now);
  });

  it('setAircraftClassification round-trips false', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(101, { altitude: 300 }), SOURCE);

    await repo.setAircraftClassification(101, SOURCE, {
      likelyAircraft: false,
      aircraftBasis: 'msl',
      groundElevation: null,
      heightAboveGround: null,
      aircraftClassifiedAt: Date.now(),
    });

    const node = await repo.getNode(101, SOURCE);
    expect(node?.likelyAircraft).toBe(false);
    expect(node?.aircraftBasis).toBe('msl');
    expect(node?.groundElevation).toBeNull();
    expect(node?.heightAboveGround).toBeNull();
  });

  it('setAircraftClassification round-trips null (unknown)', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(102), SOURCE);

    await repo.setAircraftClassification(102, SOURCE, {
      likelyAircraft: null,
      aircraftBasis: 'unknown',
      groundElevation: null,
      heightAboveGround: null,
      aircraftClassifiedAt: Date.now(),
    });

    const node = await repo.getNode(102, SOURCE);
    expect(node?.likelyAircraft).toBeNull();
    expect(node?.aircraftBasis).toBe('unknown');
  });

  it('upsertNode does NOT clobber the aircraft columns on the UPDATE path', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(103, { altitude: 3200 }), SOURCE);
    await repo.setAircraftClassification(103, SOURCE, {
      likelyAircraft: true,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
      aircraftClassifiedAt: Date.now(),
    });

    // A later packet-driven upsert (existing row -> UPDATE branch) must
    // leave the classification untouched.
    await repo.upsertNode(makeNode(103, { altitude: 3300, batteryLevel: 80 }), SOURCE);

    const node = await repo.getNode(103, SOURCE);
    expect(node?.likelyAircraft).toBe(true);
    expect(node?.aircraftBasis).toBe('agl');
    expect(node?.groundElevation).toBe(200);
    expect(node?.heightAboveGround).toBe(3000);
  });

  it('upsertNode does NOT write the aircraft columns on the INSERT/conflict path', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    // Fresh row: INSERT branch. The aircraft columns must come out NULL, not
    // whatever `upsertSet`/`newNode` would default them to if they were
    // (wrongly) included there.
    await repo.upsertNode(makeNode(104, { altitude: 3200 }), SOURCE);

    const node = await repo.getNode(104, SOURCE);
    expect(node?.likelyAircraft).toBeNull();
    expect(node?.aircraftBasis).toBeNull();
    expect(node?.groundElevation).toBeNull();
    expect(node?.heightAboveGround).toBeNull();
    expect(node?.aircraftClassifiedAt).toBeNull();
  });

  it('getUnclassifiedNodeNumsWithAltitude returns only altitude-having, never-classified nodes', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(110, { altitude: 3200 }), SOURCE); // eligible
    await repo.upsertNode(makeNode(111), SOURCE); // no altitude: not eligible
    await repo.upsertNode(makeNode(112, { altitude: 500 }), SOURCE);
    await repo.setAircraftClassification(112, SOURCE, {
      likelyAircraft: false,
      aircraftBasis: 'msl',
      groundElevation: null,
      heightAboveGround: null,
      aircraftClassifiedAt: Date.now(),
    }); // already classified: not eligible

    const ids = await repo.getUnclassifiedNodeNumsWithAltitude(SOURCE);
    expect(ids).toEqual([110]);
  });

  it('getAircraftReclassifyRows returns rows with an altitude or an existing classification', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(120, { altitude: 3200, latitude: 44.1, longitude: -78.2 }), SOURCE);
    await repo.upsertNode(makeNode(121), SOURCE); // no altitude, never classified: excluded
    await repo.upsertNode(makeNode(122), SOURCE);
    await repo.setAircraftClassification(122, SOURCE, {
      likelyAircraft: false,
      aircraftBasis: 'msl',
      groundElevation: null,
      heightAboveGround: null,
      aircraftClassifiedAt: Date.now(),
    }); // classified but no current altitude: still included (needs a clear check)

    const rows = await repo.getAircraftReclassifyRows(SOURCE);
    const nodeNums = rows.map((r) => r.nodeNum).sort((a, b) => a - b);
    expect(nodeNums).toEqual([120, 122]);

    const row120 = rows.find((r) => r.nodeNum === 120)!;
    expect(row120.altitude).toBe(3200);
    expect(row120.latitude).toBe(44.1);
    expect(row120.longitude).toBe(-78.2);
  });

  it('clearAircraftClassification nulls likelyAircraft/aircraftBasis/heightAboveGround but keeps groundElevation', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(130, { altitude: 3200 }), SOURCE);
    await repo.setAircraftClassification(130, SOURCE, {
      likelyAircraft: true,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
      aircraftClassifiedAt: Date.now(),
    });
    await repo.upsertNode(makeNode(131), SOURCE); // never classified: not counted as "affected"

    const affected = await repo.clearAircraftClassification(SOURCE);
    expect(affected).toBe(1);

    const node130 = await repo.getNode(130, SOURCE);
    expect(node130?.likelyAircraft).toBeNull();
    expect(node130?.aircraftBasis).toBeNull();
    expect(node130?.heightAboveGround).toBeNull();
    // Ground elevation is cheap DEM data, kept so a re-enable doesn't need a re-fetch.
    expect(node130?.groundElevation).toBe(200);
    // Cleared so the startup backfill re-covers the row after a re-enable.
    expect(node130?.aircraftClassifiedAt ?? null).toBeNull();
    expect(await repo.getUnclassifiedNodeNumsWithAltitude(SOURCE)).toContain(130);
  });

  it('clearAircraftClassification returns 0 and is a no-op when nothing is classified', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(140, { altitude: 3200 }), SOURCE);

    const affected = await repo.clearAircraftClassification(SOURCE);
    expect(affected).toBe(0);
  });
}

/** Phase 2 (#5364/#5365): age-out + "confirmed fixed" repository methods. */
function runAgeOutTests(getBackend: () => TestBackend) {
  const OTHER = 'src-b';
  const flag = (repo: NodesRepository, n: number, src = SOURCE) =>
    repo.setAircraftClassification(n, src, {
      likelyAircraft: true, aircraftBasis: 'msl', groundElevation: null, heightAboveGround: null, aircraftClassifiedAt: Date.now(),
    });

  it('markAircraftAgedOut / clearAircraftAgedOut round-trip isIgnored + aircraftAgedOutAt', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(200), SOURCE);
    const at = Date.now();
    await repo.markAircraftAgedOut(200, SOURCE, at);
    let node = await repo.getNode(200, SOURCE);
    expect(node?.isIgnored).toBe(true);
    expect(Number(node?.aircraftAgedOutAt)).toBe(at);
    expect(await repo.getAircraftAgedOutAt(200, SOURCE)).toBe(at);

    await repo.clearAircraftAgedOut(200, SOURCE);
    node = await repo.getNode(200, SOURCE);
    expect(node?.isIgnored).toBe(false);
    expect(node?.aircraftAgedOutAt ?? null).toBeNull();
    expect(await repo.getAircraftAgedOutAt(200, SOURCE)).toBeNull();
  });

  it('clearAircraftAgedOutMark nulls only the mark, leaving isIgnored alone', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(201), SOURCE);
    await repo.markAircraftAgedOut(201, SOURCE, Date.now());
    await repo.clearAircraftAgedOutMark(201, SOURCE);
    const node = await repo.getNode(201, SOURCE);
    expect(node?.aircraftAgedOutAt ?? null).toBeNull();
    expect(node?.isIgnored).toBe(true);
  });

  it('setAircraftFixed sets the anchor and clears the flag; null clears only the mark', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(202, { altitude: 9000 }), SOURCE);
    await flag(repo, 202);
    const at = Date.now();
    await repo.setAircraftFixed(202, SOURCE, { atMs: at, lat: 40.5, lon: -105.25 });
    let node = await repo.getNode(202, SOURCE);
    expect(node?.likelyAircraft).toBe(false);
    expect(Number(node?.aircraftFixedAt)).toBe(at);
    expect(Number(node?.aircraftFixedLatitude)).toBeCloseTo(40.5);
    expect(Number(node?.aircraftFixedLongitude)).toBeCloseTo(-105.25);

    const rows = await repo.getAircraftReclassifyRows(SOURCE);
    const row = rows.find((r) => r.nodeNum === 202);
    expect(Number(row?.aircraftFixedLatitude)).toBeCloseTo(40.5);

    await repo.setAircraftFixed(202, SOURCE, null);
    node = await repo.getNode(202, SOURCE);
    expect(node?.aircraftFixedAt ?? null).toBeNull();
    expect(node?.aircraftFixedLatitude ?? null).toBeNull();
    expect(node?.likelyAircraft).toBe(false);
  });

  it('listAircraftAgeOutCandidates returns only flagged rows of this source, normalised', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    const heard = Math.floor(Date.now() / 1000) - 3600;
    await repo.upsertNode(makeNode(210, { altitude: 9000, lastHeard: heard, latitude: 40, longitude: -105 }), SOURCE);
    await repo.upsertNode(makeNode(211, { altitude: 100 }), SOURCE);
    await repo.upsertNode(makeNode(210, { altitude: 9000 }), OTHER);
    await flag(repo, 210);
    await flag(repo, 210, OTHER);
    await repo.setAircraftClassification(211, SOURCE, {
      likelyAircraft: false, aircraftBasis: 'msl', groundElevation: null, heightAboveGround: null, aircraftClassifiedAt: Date.now(),
    });
    await repo.markAircraftAgedOut(210, OTHER, Date.now());

    const list = await repo.listAircraftAgeOutCandidates(SOURCE);
    expect(list.map((c) => c.nodeNum)).toEqual([210]);
    const c = list[0];
    expect(c.lastHeard).toBe(heard);
    expect(c.isFavorite).toBe(false);
    expect(c.isIgnored).toBe(false);
    expect(c.aircraftAgedOutAt).toBeNull();
    expect(Number(c.latitude)).toBeCloseTo(40);

    // Source isolation: the other source's aged-out row is its own.
    const other = await repo.listAircraftAgeOutCandidates(OTHER);
    expect(other).toHaveLength(1);
    expect(other[0].isIgnored).toBe(true);
    expect(other[0].aircraftAgedOutAt).not.toBeNull();
  });

  it('clearAircraftClassification also drops the fixed mark but keeps aircraftAgedOutAt', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(220, { altitude: 9000 }), SOURCE);
    await repo.upsertNode(makeNode(221, { altitude: 9000 }), SOURCE);
    await repo.setAircraftFixed(220, SOURCE, { atMs: Date.now(), lat: 1, lon: 2 });
    await flag(repo, 221);
    const at = Date.now();
    await repo.markAircraftAgedOut(221, SOURCE, at);

    await repo.clearAircraftClassification(SOURCE);
    const n220 = await repo.getNode(220, SOURCE);
    expect(n220?.aircraftFixedAt ?? null).toBeNull();
    expect(n220?.aircraftFixedLatitude ?? null).toBeNull();
    const n221 = await repo.getNode(221, SOURCE);
    expect(Number(n221?.aircraftAgedOutAt)).toBe(at);
    expect(n221?.isIgnored).toBe(true);
  });

  it('upsertNode never clobbers the Phase 2 columns', async () => {
    const backend = getBackend();
    if (!backend.available) return;
    const repo = new NodesRepository(backend.drizzleDb, backend.dbType);
    await repo.upsertNode(makeNode(230, { altitude: 9000 }), SOURCE);
    const at = Date.now();
    await repo.markAircraftAgedOut(230, SOURCE, at);
    await repo.setAircraftFixed(230, SOURCE, { atMs: at, lat: 3, lon: 4 });
    await repo.upsertNode(makeNode(230, { altitude: 9100, batteryLevel: 50 }), SOURCE);
    const node = await repo.getNode(230, SOURCE);
    expect(Number(node?.aircraftAgedOutAt)).toBe(at);
    expect(Number(node?.aircraftFixedAt)).toBe(at);
    expect(Number(node?.aircraftFixedLatitude)).toBeCloseTo(3);
    expect(Number(node?.aircraftFixedLongitude)).toBeCloseTo(4);

    // Fresh INSERT leaves them null.
    await repo.upsertNode(makeNode(231, { altitude: 9000 }), SOURCE);
    const fresh = await repo.getNode(231, SOURCE);
    expect(fresh?.aircraftAgedOutAt ?? null).toBeNull();
    expect(fresh?.aircraftFixedAt ?? null).toBeNull();
  });
}

describe('NodesRepository aircraft classification - SQLite Backend', () => {
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
  runAircraftTests(() => backend);
  runAgeOutTests(() => backend);
});

describe.skipIf(!postgresAvailable)('NodesRepository aircraft classification - PostgreSQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE, 'nodes_aircraft');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
  });
  runAircraftTests(() => backend);
  runAgeOutTests(() => backend);
});

describe.skipIf(!mysqlAvailable)('NodesRepository aircraft classification - MySQL Backend', () => {
  let backend: TestBackend;
  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE, 'nodes_aircraft');
  });
  afterAll(async () => {
    if (backend) await backend.close();
  });
  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'nodes');
  });
  runAircraftTests(() => backend);
  runAgeOutTests(() => backend);
});
