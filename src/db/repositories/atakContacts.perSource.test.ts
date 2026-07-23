/**
 * Per-source isolation tests for AtakContactsRepository.
 *
 * Verifies the composite (uid, sourceId) PK truly isolates ATAK contacts
 * between sources — the same physical ATAK device (same uid) relayed by two
 * different Meshtastic sources must produce two independent rows, and
 * `getContacts(sourceId)` must never leak the other source's row. Also
 * verifies withSourceScope's fail-closed behavior on an empty sourceId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AtakContactsRepository, type AtakContactRow } from './atakContacts.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

function makeRow(overrides: Partial<AtakContactRow> = {}): AtakContactRow {
  const now = Date.now();
  return {
    uid: 'EUD-SHARED',
    sourceId: SRC_A,
    nodeNum: 0xaabbccdd,
    callsign: 'ALPHA-1',
    deviceCallsign: 'EUD-SHARED',
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

describe('AtakContactsRepository - per-source isolation', () => {
  let testDb: TestDb;
  let repo: AtakContactsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new AtakContactsRepository(testDb.db, 'sqlite');
  });

  afterEach(() => {
    testDb.close();
  });

  it('same uid under two sources produces two independent rows', async () => {
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_A, callsign: 'On A' }));
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_B, callsign: 'On B' }));

    expect(await repo.hasContact('EUD-SHARED', SRC_A)).toBe(true);
    expect(await repo.hasContact('EUD-SHARED', SRC_B)).toBe(true);

    const onA = await repo.getContacts(SRC_A);
    expect(onA).toHaveLength(1);
    expect(onA[0].callsign).toBe('On A');

    const onB = await repo.getContacts(SRC_B);
    expect(onB).toHaveLength(1);
    expect(onB[0].callsign).toBe('On B');
  });

  it('getContacts(A) excludes B rows and vice versa', async () => {
    await repo.upsertContact(makeRow({ uid: 'EUD-001', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-002', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-003', sourceId: SRC_B }));

    const onA = await repo.getContacts(SRC_A);
    expect(onA.map((c) => c.uid).sort()).toEqual(['EUD-001', 'EUD-002']);

    const onB = await repo.getContacts(SRC_B);
    expect(onB.map((c) => c.uid)).toEqual(['EUD-003']);
  });

  it('upserting on source A does not affect the same uid on source B', async () => {
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_A, battery: 100 }));
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_B, battery: 50 }));

    // Repeated update on A only.
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_A, battery: 10 }));

    const onA = await repo.getContacts(SRC_A);
    expect(onA[0].battery).toBe(10);

    const onB = await repo.getContacts(SRC_B);
    expect(onB[0].battery).toBe(50);
  });

  it('deleteContactsForSource(A) does not remove B rows for the same uid', async () => {
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_A }));
    await repo.upsertContact(makeRow({ uid: 'EUD-SHARED', sourceId: SRC_B }));

    await repo.deleteContactsForSource(SRC_A);

    expect(await repo.hasContact('EUD-SHARED', SRC_A)).toBe(false);
    expect(await repo.hasContact('EUD-SHARED', SRC_B)).toBe(true);
  });

  it('getContacts throws on an empty sourceId (withSourceScope fail-closed)', async () => {
    await expect(repo.getContacts('')).rejects.toThrow(/sourceId is required/);
  });

  it('deleteContactsForSource throws on an empty sourceId (withSourceScope fail-closed)', async () => {
    await expect(repo.deleteContactsForSource('')).rejects.toThrow(/sourceId is required/);
  });
});
