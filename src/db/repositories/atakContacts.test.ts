/**
 * Multi-Database ATAK Contacts Repository Tests
 *
 * Validates AtakContactsRepository against SQLite, PostgreSQL, and MySQL
 * backends using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory, schema from the migration registry via
 * createTestDb() — migration 127 creates atak_contacts).
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { AtakContactsRepository, type AtakContactRow } from './atakContacts.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

// Note: SQLite DDL comes from createTestDb() via the migration registry.

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS atak_contacts CASCADE;
  CREATE TABLE atak_contacts (
    "uid" TEXT NOT NULL, "sourceId" TEXT NOT NULL,
    "nodeNum" BIGINT, "callsign" TEXT, "deviceCallsign" TEXT,
    "team" INTEGER, "role" INTEGER, "battery" INTEGER,
    "latitude" REAL, "longitude" REAL, "altitude" INTEGER,
    "speed" INTEGER, "course" INTEGER,
    "lastSeen" BIGINT NOT NULL, "createdAt" BIGINT NOT NULL,
    PRIMARY KEY ("uid","sourceId"))
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS atak_contacts;
  CREATE TABLE atak_contacts ( uid VARCHAR(191) NOT NULL,
    sourceId VARCHAR(191) NOT NULL, nodeNum BIGINT,
    callsign TEXT, deviceCallsign TEXT, team INT, role INT,
    battery INT, latitude DOUBLE, longitude DOUBLE,
    altitude INT, speed INT, course INT,
    lastSeen BIGINT NOT NULL, createdAt BIGINT NOT NULL,
    PRIMARY KEY (uid, sourceId))
`;

function makeRow(overrides: Partial<AtakContactRow> = {}): AtakContactRow {
  const now = Date.now();
  return {
    uid: 'EUD-001',
    sourceId: SRC_A,
    nodeNum: 0xaabbccdd,
    callsign: 'ALPHA-1',
    deviceCallsign: 'EUD-001',
    team: 9,
    role: 1,
    battery: 85,
    latitude: 38.8895,
    longitude: -77.0353,
    altitude: 12,
    speed: 3,
    course: 270,
    lastSeen: now,
    createdAt: now,
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 */
function runAtakContactsTests(getBackend: () => TestBackend) {
  let repo: AtakContactsRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new AtakContactsRepository(backend.drizzleDb, backend.dbType);
  });

  it('upsertContact - inserts a new row and getContacts returns it', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const row = makeRow();
    await repo.upsertContact(row);

    const contacts = await repo.getContacts(SRC_A);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].uid).toBe('EUD-001');
    expect(contacts[0].sourceId).toBe(SRC_A);
    expect(contacts[0].callsign).toBe('ALPHA-1');
    expect(contacts[0].deviceCallsign).toBe('EUD-001');
    expect(contacts[0].team).toBe(9);
    expect(contacts[0].role).toBe(1);
    expect(contacts[0].battery).toBe(85);
    expect(contacts[0].latitude).toBeCloseTo(38.8895);
    expect(contacts[0].longitude).toBeCloseTo(-77.0353);
    expect(contacts[0].altitude).toBe(12);
    expect(contacts[0].speed).toBe(3);
    expect(contacts[0].course).toBe(270);
  });

  it('upsertContact - repeated upsert on same (uid, sourceId) updates in place, preserving createdAt', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const originalCreatedAt = Date.now() - 60_000;
    await repo.upsertContact(makeRow({ createdAt: originalCreatedAt, lastSeen: originalCreatedAt, callsign: 'ALPHA-1', battery: 50 }));

    const laterLastSeen = Date.now();
    await repo.upsertContact(makeRow({ createdAt: laterLastSeen, lastSeen: laterLastSeen, callsign: 'ALPHA-1-RENAMED', battery: 42 }));

    const contacts = await repo.getContacts(SRC_A);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].callsign).toBe('ALPHA-1-RENAMED');
    expect(contacts[0].battery).toBe(42);
    expect(contacts[0].lastSeen).toBe(laterLastSeen);
    // createdAt must NOT be overwritten by the second upsert.
    expect(contacts[0].createdAt).toBe(originalCreatedAt);
  });

  it('getContacts - scoped to source and ordered newest lastSeen first', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const t1 = Date.now() - 20_000;
    const t2 = Date.now() - 10_000;
    const t3 = Date.now();

    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_A, lastSeen: t1, createdAt: t1 }));
    await repo.upsertContact(makeRow({ uid: 'EUD-002', sourceId: SRC_A, lastSeen: t3, createdAt: t3 }));
    await repo.upsertContact(makeRow({ uid: 'EUD-003', sourceId: SRC_A, lastSeen: t2, createdAt: t2 }));
    await repo.upsertContact(makeRow({ uid: 'EUD-999', sourceId: SRC_B, lastSeen: t3, createdAt: t3 }));

    const onA = await repo.getContacts(SRC_A);
    expect(onA.map((c) => c.uid)).toEqual(['EUD-002', 'EUD-003', 'EUD-001']);

    const onB = await repo.getContacts(SRC_B);
    expect(onB).toHaveLength(1);
    expect(onB[0].uid).toBe('EUD-999');

    const unknown = await repo.getContacts('nonexistent-source');
    expect(unknown).toHaveLength(0);
  });

  it('bogus-position guard - null lat/lon rows persist and round-trip as null', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertContact(makeRow({ uid: 'EUD-NULL-ISLAND', latitude: null, longitude: null }));

    const contacts = await repo.getContacts(SRC_A);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].latitude).toBeNull();
    expect(contacts[0].longitude).toBeNull();
  });

  it('upsertContact - handles null optional fields (no group/status)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertContact(makeRow({
      uid: 'EUD-NO-GROUP',
      team: null,
      role: null,
      battery: null,
      altitude: null,
      speed: null,
      course: null,
      nodeNum: null,
      callsign: null,
      deviceCallsign: null,
    }));

    const contacts = await repo.getContacts(SRC_A);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].team).toBeNull();
    expect(contacts[0].role).toBeNull();
    expect(contacts[0].battery).toBeNull();
    expect(contacts[0].callsign).toBeNull();
    expect(contacts[0].deviceCallsign).toBeNull();
  });

  it('deleteContactsOlderThan - removes rows older than cutoff, keeps newer ones, across all sources', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const old = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    const recent = Date.now() - 60 * 1000; // 1 min ago

    await repo.upsertContact(makeRow({ uid: 'EUD-OLD', sourceId: SRC_A, lastSeen: old, createdAt: old }));
    await repo.upsertContact(makeRow({ uid: 'EUD-RECENT', sourceId: SRC_A, lastSeen: recent, createdAt: recent }));
    await repo.upsertContact(makeRow({ uid: 'EUD-OLD-B', sourceId: SRC_B, lastSeen: old, createdAt: old }));

    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    const deleted = await repo.deleteContactsOlderThan(cutoff);
    expect(deleted).toBe(2);

    const onA = await repo.getContacts(SRC_A);
    expect(onA.map((c) => c.uid)).toEqual(['EUD-RECENT']);

    const onB = await repo.getContacts(SRC_B);
    expect(onB).toHaveLength(0);
  });

  it('deleteContactsForSource - scoped delete, does not affect other sources', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-002', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_B }));

    const deleted = await repo.deleteContactsForSource(SRC_A);
    expect(deleted).toBe(2);

    expect(await repo.getContacts(SRC_A)).toHaveLength(0);
    const onB = await repo.getContacts(SRC_B);
    expect(onB).toHaveLength(1);
    expect(onB[0].sourceId).toBe(SRC_B);
  });

  it('getContactSourceIds - returns distinct sourceIds present', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-002', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_B }));

    const sourceIds = (await repo.getContactSourceIds()).sort();
    expect(sourceIds).toEqual([SRC_A, SRC_B]);
  });

  it('hasContact - true when present, false otherwise', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_A }));

    expect(await repo.hasContact('EUD-001', SRC_A)).toBe(true);
    expect(await repo.hasContact('EUD-001', SRC_B)).toBe(false);
    expect(await repo.hasContact('EUD-999', SRC_A)).toBe(false);
  });
}

// --- SQLite Backend ---
describe('AtakContactsRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runAtakContactsTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('AtakContactsRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for atak contacts tests');
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
    await clearTable(backend, 'atak_contacts');
  });

  runAtakContactsTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('AtakContactsRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for atak contacts tests');
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
    await clearTable(backend, 'atak_contacts');
  });

  runAtakContactsTests(() => backend);
});
