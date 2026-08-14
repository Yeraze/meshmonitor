/**
 * Multi-Database Reticulum Repository Tests (epic #3960, Phase 1a WP1).
 *
 * Validates ReticulumRepository against SQLite, PostgreSQL, and MySQL
 * backends using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory, hand-rolled DDL below matching migrations
 * 140/141 exactly).
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import {
  ReticulumRepository,
  DEFAULT_RETICULUM_DESTINATIONS_MAX,
  type UpsertDestinationInput,
  type UpsertInterfaceInput,
  type UpdateDestinationPositionInput,
  type UpdateInterfaceRadioConfigInput,
} from './reticulum.js';
import {
  TestBackend,
  createSqliteBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

const SQLITE_CREATE = `
  CREATE TABLE reticulum_destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId TEXT NOT NULL,
    destinationHash TEXT NOT NULL,
    identityHash TEXT, appName TEXT, aspects TEXT, displayName TEXT, appDataB64 TEXT,
    hops INTEGER, nextHopInterface TEXT,
    rssi INTEGER, snr REAL, quality INTEGER,
    announceCount INTEGER NOT NULL DEFAULT 0,
    firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL, lastAnnounceAt INTEGER,
    isFavorite INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    latitude REAL, longitude REAL, altitude REAL, speed REAL, bearing REAL, accuracy REAL,
    positionUpdatedAt INTEGER
  );
  CREATE UNIQUE INDEX reticulum_destinations_source_hash_idx ON reticulum_destinations(sourceId, destinationHash);
  CREATE TABLE reticulum_interfaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceId TEXT NOT NULL,
    interfaceName TEXT NOT NULL,
    interfaceType TEXT, interfaceHash TEXT, mode TEXT,
    status TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0, bitrate INTEGER,
    txBytes INTEGER NOT NULL DEFAULT 0, rxBytes INTEGER NOT NULL DEFAULT 0,
    lastSeenAt INTEGER NOT NULL,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    frequency REAL, bandwidth REAL, spreadingFactor INTEGER, codingRate INTEGER, txPower INTEGER,
    stAlock REAL, ltAlock REAL, radioState INTEGER, deviceInfoJson TEXT
  );
  CREATE UNIQUE INDEX reticulum_interfaces_source_name_idx ON reticulum_interfaces(sourceId, interfaceName);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
`;

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS reticulum_destinations CASCADE;
  DROP TABLE IF EXISTS reticulum_interfaces CASCADE;
  DROP TABLE IF EXISTS settings CASCADE;
  CREATE TABLE reticulum_destinations (
    id SERIAL PRIMARY KEY,
    "sourceId" TEXT NOT NULL, "destinationHash" TEXT NOT NULL,
    "identityHash" TEXT, "appName" TEXT, aspects TEXT, "displayName" TEXT, "appDataB64" TEXT,
    hops INTEGER, "nextHopInterface" TEXT,
    rssi INTEGER, snr DOUBLE PRECISION, quality INTEGER,
    "announceCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" BIGINT NOT NULL, "lastSeen" BIGINT NOT NULL, "lastAnnounceAt" BIGINT,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL,
    latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, altitude DOUBLE PRECISION,
    speed DOUBLE PRECISION, bearing DOUBLE PRECISION, accuracy DOUBLE PRECISION,
    "positionUpdatedAt" BIGINT
  );
  CREATE UNIQUE INDEX reticulum_destinations_source_hash_idx ON reticulum_destinations("sourceId", "destinationHash");
  CREATE TABLE reticulum_interfaces (
    id SERIAL PRIMARY KEY,
    "sourceId" TEXT NOT NULL, "interfaceName" TEXT NOT NULL,
    "interfaceType" TEXT, "interfaceHash" TEXT, mode TEXT,
    status TEXT NOT NULL, online BOOLEAN NOT NULL DEFAULT false, bitrate INTEGER,
    "txBytes" BIGINT NOT NULL DEFAULT 0, "rxBytes" BIGINT NOT NULL DEFAULT 0,
    "lastSeenAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL,
    frequency DOUBLE PRECISION, bandwidth DOUBLE PRECISION, "spreadingFactor" INTEGER,
    "codingRate" INTEGER, "txPower" INTEGER, "stAlock" DOUBLE PRECISION, "ltAlock" DOUBLE PRECISION,
    "radioState" BOOLEAN, "deviceInfoJson" TEXT
  );
  CREATE UNIQUE INDEX reticulum_interfaces_source_name_idx ON reticulum_interfaces("sourceId", "interfaceName");
  CREATE TABLE settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL, "updatedAt" BIGINT NOT NULL
  );
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS reticulum_destinations;
  DROP TABLE IF EXISTS reticulum_interfaces;
  DROP TABLE IF EXISTS settings;
  CREATE TABLE reticulum_destinations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sourceId VARCHAR(191) NOT NULL, destinationHash VARCHAR(64) NOT NULL,
    identityHash VARCHAR(64), appName VARCHAR(255), aspects VARCHAR(255),
    displayName VARCHAR(255), appDataB64 TEXT,
    hops INT, nextHopInterface VARCHAR(255),
    rssi INT, snr DOUBLE, quality INT,
    announceCount INT NOT NULL DEFAULT 0,
    firstSeen BIGINT NOT NULL, lastSeen BIGINT NOT NULL, lastAnnounceAt BIGINT,
    isFavorite TINYINT(1) NOT NULL DEFAULT 0,
    createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL,
    latitude DOUBLE, longitude DOUBLE, altitude DOUBLE, speed DOUBLE, bearing DOUBLE, accuracy DOUBLE,
    positionUpdatedAt BIGINT,
    UNIQUE KEY reticulum_destinations_source_hash_idx (sourceId, destinationHash)
  );
  CREATE TABLE reticulum_interfaces (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sourceId VARCHAR(191) NOT NULL, interfaceName VARCHAR(255) NOT NULL,
    interfaceType VARCHAR(128), interfaceHash VARCHAR(64), mode VARCHAR(64),
    status VARCHAR(16) NOT NULL, online TINYINT(1) NOT NULL DEFAULT 0, bitrate INT,
    txBytes BIGINT NOT NULL DEFAULT 0, rxBytes BIGINT NOT NULL DEFAULT 0,
    lastSeenAt BIGINT NOT NULL,
    createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL,
    frequency DOUBLE, bandwidth DOUBLE, spreadingFactor INT, codingRate INT, txPower INT,
    stAlock DOUBLE, ltAlock DOUBLE, radioState TINYINT(1), deviceInfoJson TEXT,
    UNIQUE KEY reticulum_interfaces_source_name_idx (sourceId, interfaceName)
  );
  CREATE TABLE settings (
    \`key\` VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL,
    createdAt BIGINT NOT NULL, updatedAt BIGINT NOT NULL
  );
`;

function makeDest(overrides: Partial<UpsertDestinationInput> = {}): UpsertDestinationInput {
  return {
    destinationHash: 'a'.repeat(32),
    appName: 'lxmf.delivery',
    displayName: 'Alice',
    rssi: -72,
    snr: 4.5,
    quality: 88,
    ...overrides,
  };
}

function makeIface(overrides: Partial<UpsertInterfaceInput> = {}): UpsertInterfaceInput {
  return {
    interfaceName: 'TCPClientInterface[rns.example.com]',
    interfaceType: 'TCPClientInterface',
    status: 'up',
    online: true,
    txBytes: 100,
    rxBytes: 200,
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 */
function runReticulumTests(getBackend: () => TestBackend) {
  let repo: ReticulumRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new ReticulumRepository(backend.drizzleDb, backend.dbType);
  });

  it('upsertDestination - inserts a new row with signal columns and getDestination returns it', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertDestination(SRC_A, makeDest());

    const row = await repo.getDestination(SRC_A, 'a'.repeat(32));
    expect(row).not.toBeNull();
    expect(row!.sourceId).toBe(SRC_A);
    expect(row!.appName).toBe('lxmf.delivery');
    expect(row!.displayName).toBe('Alice');
    expect(row!.rssi).toBe(-72);
    expect(row!.snr).toBeCloseTo(4.5);
    expect(row!.quality).toBe(88);
    expect(row!.announceCount).toBe(1);
    expect(row!.isFavorite).toBe(false);
  });

  it('upsertDestination - repeated announce bumps announceCount/lastSeen and merges only observed fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const t1 = Date.now() - 10_000;
    await repo.upsertDestination(SRC_A, makeDest({ announceAt: t1, displayName: 'Alice' }));

    const t2 = Date.now();
    // Second announce omits displayName entirely — must NOT clobber the stored value.
    await repo.upsertDestination(SRC_A, {
      destinationHash: 'a'.repeat(32),
      rssi: -60,
      announceAt: t2,
    });

    const row = await repo.getDestination(SRC_A, 'a'.repeat(32));
    expect(row!.announceCount).toBe(2);
    expect(row!.lastSeen).toBe(t2);
    expect(row!.lastAnnounceAt).toBe(t2);
    expect(row!.rssi).toBe(-60);
    // Preserved from the first announce.
    expect(row!.displayName).toBe('Alice');
  });

  it('setDestinationFavorite - toggles isFavorite without touching other fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertDestination(SRC_A, makeDest());
    await repo.setDestinationFavorite(SRC_A, 'a'.repeat(32), true);

    let row = await repo.getDestination(SRC_A, 'a'.repeat(32));
    expect(row!.isFavorite).toBe(true);

    await repo.setDestinationFavorite(SRC_A, 'a'.repeat(32), false);
    row = await repo.getDestination(SRC_A, 'a'.repeat(32));
    expect(row!.isFavorite).toBe(false);
  });

  it('listDestinations - scoped to source, newest lastSeen first, supports favoriteOnly', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const t1 = Date.now() - 20_000;
    const t2 = Date.now() - 10_000;
    const t3 = Date.now();

    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'b'.repeat(32), announceAt: t1 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'c'.repeat(32), announceAt: t3 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'd'.repeat(32), announceAt: t2 }));
    await repo.upsertDestination(SRC_B, makeDest({ destinationHash: 'e'.repeat(32), announceAt: t3 }));

    const onA = await repo.listDestinations(SRC_A);
    expect(onA.map((d) => d.destinationHash)).toEqual(['c'.repeat(32), 'd'.repeat(32), 'b'.repeat(32)]);

    const onB = await repo.listDestinations(SRC_B);
    expect(onB).toHaveLength(1);
    expect(onB[0].destinationHash).toBe('e'.repeat(32));

    await repo.setDestinationFavorite(SRC_A, 'c'.repeat(32), true);
    const favoritesOnA = await repo.listDestinations(SRC_A, { favoriteOnly: true });
    expect(favoritesOnA.map((d) => d.destinationHash)).toEqual(['c'.repeat(32)]);
  });

  it('upsertInterface - inserts a new row and getInterface returns it', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface());

    const row = await repo.getInterface(SRC_A, 'TCPClientInterface[rns.example.com]');
    expect(row).not.toBeNull();
    expect(row!.sourceId).toBe(SRC_A);
    expect(row!.status).toBe('up');
    expect(row!.online).toBe(true);
    expect(row!.txBytes).toBe(100);
    expect(row!.rxBytes).toBe(200);
  });

  it('upsertInterface - repeated poll overwrites the full snapshot, preserves createdAt', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface({ txBytes: 100, rxBytes: 200, status: 'up' }));
    const first = await repo.getInterface(SRC_A, 'TCPClientInterface[rns.example.com]');

    await repo.upsertInterface(SRC_A, makeIface({ txBytes: 999, rxBytes: 888, status: 'down', online: false }));
    const second = await repo.getInterface(SRC_A, 'TCPClientInterface[rns.example.com]');

    expect(second!.txBytes).toBe(999);
    expect(second!.rxBytes).toBe(888);
    expect(second!.status).toBe('down');
    expect(second!.online).toBe(false);
    expect(second!.createdAt).toBe(first!.createdAt);
  });

  it('listInterfaces - scoped to source', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'iface-1' }));
    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'iface-2' }));
    await repo.upsertInterface(SRC_B, makeIface({ interfaceName: 'iface-3' }));

    const onA = await repo.listInterfaces(SRC_A);
    expect(onA.map((i) => i.interfaceName).sort()).toEqual(['iface-1', 'iface-2']);

    const onB = await repo.listInterfaces(SRC_B);
    expect(onB.map((i) => i.interfaceName)).toEqual(['iface-3']);
  });

  it('upsertDestination - retention: prunes oldest non-favorite rows beyond reticulum_destinations_max', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    // Set a small cap so the test doesn't need thousands of rows.
    const now = Date.now();
    if (backend.dbType === 'postgres') {
      await backend.exec(
        `INSERT INTO settings (key, value, "createdAt", "updatedAt") VALUES ('reticulum_destinations_max', '3', ${now}, ${now})`,
      );
    } else if (backend.dbType === 'mysql') {
      await backend.exec(
        `INSERT INTO settings (\`key\`, value, createdAt, updatedAt) VALUES ('reticulum_destinations_max', '3', ${now}, ${now})`,
      );
    } else {
      await backend.exec(
        `INSERT INTO settings (key, value, createdAt, updatedAt) VALUES ('reticulum_destinations_max', '3', ${now}, ${now})`,
      );
    }

    const base = Date.now() - 100_000;
    // Insert 3 rows in ascending lastSeen order, then favorite the oldest.
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '1'.repeat(32), announceAt: base + 1 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '2'.repeat(32), announceAt: base + 2 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '3'.repeat(32), announceAt: base + 3 }));
    await repo.setDestinationFavorite(SRC_A, '1'.repeat(32), true);

    // A 4th row pushes the source to 4 rows, 1 over the cap of 3. The oldest
    // NON-favorite row ('2') should be pruned; the favorited '1' survives
    // even though it is older than '2'.
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '4'.repeat(32), announceAt: base + 4 }));

    const remaining = await repo.listDestinations(SRC_A);
    const hashes = remaining.map((d) => d.destinationHash).sort();
    expect(hashes).toEqual(['1'.repeat(32), '3'.repeat(32), '4'.repeat(32)].sort());
    expect(await repo.getDestination(SRC_A, '2'.repeat(32))).toBeNull();
    // Favorite survived despite being older than the pruned row.
    expect((await repo.getDestination(SRC_A, '1'.repeat(32)))!.isFavorite).toBe(true);
  });

  // PR review finding 2: pruning (a COUNT(*) + candidate scan) used to run on
  // every upsertDestination call, including pure updates that can never grow
  // the table. Spy on the private pruneDestinations to assert it fires only
  // on the genuine-insert path, not on repeat announces of the same row.
  it('upsertDestination - prunes only on a genuine insert, never on a repeat-announce update', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const pruneSpy = vi.spyOn(repo as unknown as { pruneDestinations: () => Promise<void> }, 'pruneDestinations');

    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '5'.repeat(32) }));
    expect(pruneSpy).toHaveBeenCalledTimes(1);

    // Three repeat announces of the SAME destination (pure updates) must not
    // trigger any additional prune calls.
    for (let i = 0; i < 3; i++) {
      await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '5'.repeat(32), rssi: -50 - i }));
    }
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    expect((await repo.getDestination(SRC_A, '5'.repeat(32)))!.announceCount).toBe(4);

    // A second genuine insert (new destinationHash) triggers exactly one more.
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '6'.repeat(32) }));
    expect(pruneSpy).toHaveBeenCalledTimes(2);

    pruneSpy.mockRestore();
  });

  it('countDestinations / countInterfaces - match list length without loading full rows', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.countDestinations(SRC_A)).toBe(0);
    expect(await repo.countInterfaces(SRC_A)).toBe(0);

    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '7'.repeat(32) }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: '8'.repeat(32) }));
    await repo.upsertDestination(SRC_B, makeDest({ destinationHash: '9'.repeat(32) }));
    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'count-iface-1' }));

    expect(await repo.countDestinations(SRC_A)).toBe(2);
    expect(await repo.countDestinations(SRC_B)).toBe(1);
    expect(await repo.countInterfaces(SRC_A)).toBe(1);
    expect(await repo.countInterfaces(SRC_B)).toBe(0);
  });

  // ============ Position (Phase 3 WP3, migration 144) ============

  it('updateDestinationPosition - a fresh sample writes all six position columns + positionUpdatedAt', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: 'pos-1'.padEnd(32, '0') }));
    const positionUpdatedAt = Date.now();
    const patch: UpdateDestinationPositionInput = {
      destinationHash: 'pos-1'.padEnd(32, '0'),
      latitude: 40.7128,
      longitude: -74.006,
      altitude: 10.5,
      speed: 1.2,
      bearing: 90.0,
      accuracy: 3.5,
      positionUpdatedAt,
    };
    await repo.updateDestinationPosition(SRC_A, patch);

    const row = await repo.getDestination(SRC_A, 'pos-1'.padEnd(32, '0'));
    expect(row!.latitude).toBeCloseTo(40.7128);
    expect(row!.longitude).toBeCloseTo(-74.006);
    expect(row!.altitude).toBeCloseTo(10.5);
    expect(row!.speed).toBeCloseTo(1.2);
    expect(row!.bearing).toBeCloseTo(90.0);
    expect(row!.accuracy).toBeCloseTo(3.5);
    expect(row!.positionUpdatedAt).toBe(positionUpdatedAt);
  });

  it('updateDestinationPosition - LATEST-ONLY: a second sample fully overwrites the first, including clearing omitted optional fields', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const hash = 'pos-2'.padEnd(32, '0');
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: hash }));

    await repo.updateDestinationPosition(SRC_A, {
      destinationHash: hash,
      latitude: 10,
      longitude: 20,
      altitude: 100,
      speed: 5,
      bearing: 45,
      accuracy: 2,
      positionUpdatedAt: Date.now() - 10_000,
    });

    // Second sample omits altitude/speed/bearing/accuracy entirely — unlike
    // upsertDestination's per-field merge, a position sample is a full
    // overwrite (each sample is a fresh GPS fix), so the omitted optional
    // fields must be cleared to null, not preserved from the first sample.
    const t2 = Date.now();
    await repo.updateDestinationPosition(SRC_A, {
      destinationHash: hash,
      latitude: 11,
      longitude: 21,
      positionUpdatedAt: t2,
    });

    const row = await repo.getDestination(SRC_A, hash);
    expect(row!.latitude).toBeCloseTo(11);
    expect(row!.longitude).toBeCloseTo(21);
    expect(row!.altitude).toBeNull();
    expect(row!.speed).toBeNull();
    expect(row!.bearing).toBeNull();
    expect(row!.accuracy).toBeNull();
    expect(row!.positionUpdatedAt).toBe(t2);
  });

  it('getDestinationsWithPosition - only returns destinations with a non-null lat/lon, scoped to source, newest position first', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const withPos1 = 'pos-3'.padEnd(32, '0');
    const withPos2 = 'pos-4'.padEnd(32, '0');
    const withoutPos = 'pos-5'.padEnd(32, '0');
    const otherSourcePos = 'pos-6'.padEnd(32, '0');

    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: withPos1 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: withPos2 }));
    await repo.upsertDestination(SRC_A, makeDest({ destinationHash: withoutPos }));
    await repo.upsertDestination(SRC_B, makeDest({ destinationHash: otherSourcePos }));

    const t1 = Date.now() - 10_000;
    const t2 = Date.now();
    await repo.updateDestinationPosition(SRC_A, { destinationHash: withPos1, latitude: 1, longitude: 1, positionUpdatedAt: t1 });
    await repo.updateDestinationPosition(SRC_A, { destinationHash: withPos2, latitude: 2, longitude: 2, positionUpdatedAt: t2 });
    await repo.updateDestinationPosition(SRC_B, { destinationHash: otherSourcePos, latitude: 3, longitude: 3, positionUpdatedAt: t2 });

    const onA = await repo.getDestinationsWithPosition(SRC_A);
    expect(onA.map((d) => d.destinationHash)).toEqual([withPos2, withPos1]);

    const onB = await repo.getDestinationsWithPosition(SRC_B);
    expect(onB.map((d) => d.destinationHash)).toEqual([otherSourcePos]);
  });

  // ============ Interface radio config (Phase 3 WP3, migration 145) ============

  it('getInterfaceRadioConfig - returns all-null for an interface that never had own-mode config written', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'radio-iface-1' }));
    const config = await repo.getInterfaceRadioConfig(SRC_A, 'radio-iface-1');
    expect(config).not.toBeNull();
    expect(config!.frequency).toBeNull();
    expect(config!.radioState).toBeNull();
    expect(config!.deviceInfoJson).toBeNull();
  });

  it('getInterfaceRadioConfig - returns null for a nonexistent interface', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    expect(await repo.getInterfaceRadioConfig(SRC_A, 'does-not-exist')).toBeNull();
  });

  it('setInterfaceRadioConfig - a full patch round-trips through getInterfaceRadioConfig', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'radio-iface-2' }));
    const patch: UpdateInterfaceRadioConfigInput = {
      frequency: 915000000,
      bandwidth: 125000,
      spreadingFactor: 8,
      codingRate: 5,
      txPower: 17,
      stAlock: 33.3,
      ltAlock: 66.6,
      radioState: true,
      deviceInfoJson: '{"fw":"1.60","mcu":"1284p"}',
    };
    await repo.setInterfaceRadioConfig(SRC_A, 'radio-iface-2', patch);

    const config = await repo.getInterfaceRadioConfig(SRC_A, 'radio-iface-2');
    expect(config!.frequency).toBeCloseTo(915000000);
    expect(config!.bandwidth).toBeCloseTo(125000);
    expect(config!.spreadingFactor).toBe(8);
    expect(config!.codingRate).toBe(5);
    expect(config!.txPower).toBe(17);
    expect(config!.stAlock).toBeCloseTo(33.3);
    expect(config!.ltAlock).toBeCloseTo(66.6);
    expect(config!.radioState).toBe(true);
    expect(config!.deviceInfoJson).toBe('{"fw":"1.60","mcu":"1284p"}');
  });

  it('setInterfaceRadioConfig - a partial patch only overwrites the fields it carries, preserving the rest', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertInterface(SRC_A, makeIface({ interfaceName: 'radio-iface-3' }));
    await repo.setInterfaceRadioConfig(SRC_A, 'radio-iface-3', {
      frequency: 915000000,
      spreadingFactor: 8,
      radioState: true,
    });

    // Second call only touches txPower — frequency/spreadingFactor/radioState
    // from the first call must survive untouched (partial merge, not a
    // full-snapshot overwrite like updateDestinationPosition).
    await repo.setInterfaceRadioConfig(SRC_A, 'radio-iface-3', { txPower: 20 });

    const config = await repo.getInterfaceRadioConfig(SRC_A, 'radio-iface-3');
    expect(config!.frequency).toBeCloseTo(915000000);
    expect(config!.spreadingFactor).toBe(8);
    expect(config!.radioState).toBe(true);
    expect(config!.txPower).toBe(20);
  });

  it('upsertDestination - defaults to DEFAULT_RETICULUM_DESTINATIONS_MAX when unset', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }
    expect(DEFAULT_RETICULUM_DESTINATIONS_MAX).toBe(2000);
    // No explicit assertion beyond the constant here — the "no setting row"
    // path is exercised implicitly by every other test in this suite (none
    // seed reticulum_destinations_max), which never trip pruning at low counts.
  });
}

// --- SQLite Backend ---
describe('ReticulumRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    backend = createSqliteBackend(SQLITE_CREATE);
  });

  afterEach(async () => {
    await backend.close();
  });

  runReticulumTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('ReticulumRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for reticulum tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'reticulum_destinations');
    await clearTable(backend, 'reticulum_interfaces');
    await clearTable(backend, 'settings');
  });

  runReticulumTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('ReticulumRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for reticulum tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'reticulum_destinations');
    await clearTable(backend, 'reticulum_interfaces');
    await clearTable(backend, 'settings');
  });

  runReticulumTests(() => backend);
});
