/**
 * `meshcore_nodes.lastHeard` semantics — #5131 follow-up.
 *
 * #5132 made a telemetry round-trip stamp `lastHeard`, but the reporter saw
 * the bug again afterwards: telemetry under an hour old, yet an inactive-node
 * alert citing 13–21 hours. The forward stamp was landing; the next contact
 * sync was undoing it. `persistContact()` writes the firmware's own
 * `contact.lastSeen`, which the device refreshes only on an ADVERT, and
 * `upsertNode` had no ordering rule — so last writer won, and for a node that
 * adverts twice a day the last writer was almost always the stale one.
 *
 * These tests pin the rule that makes every receive path stick: `lastHeard`
 * moves forward only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE = 'src-a';
const KEY = 'aa'.repeat(32);

describe('MeshCoreRepository — lastHeard is monotonic (#5131)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  const readLastHeard = async (): Promise<number | null | undefined> =>
    (await repo.getNodeByPublicKeyAndSource(KEY, SOURCE))?.lastHeard;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('accepts a newer lastHeard', async () => {
    await repo.upsertNode({ publicKey: KEY, lastHeard: 1_000 }, SOURCE);
    await repo.upsertNode({ publicKey: KEY, lastHeard: 2_000 }, SOURCE);
    expect(await readLastHeard()).toBe(2_000);
  });

  it('ignores an older lastHeard instead of rewinding', async () => {
    await repo.upsertNode({ publicKey: KEY, lastHeard: 2_000 }, SOURCE);
    await repo.upsertNode({ publicKey: KEY, lastHeard: 1_000 }, SOURCE);
    expect(await readLastHeard()).toBe(2_000);
  });

  it('ignores an equal lastHeard (no-op, not an error)', async () => {
    await repo.upsertNode({ publicKey: KEY, lastHeard: 2_000 }, SOURCE);
    await repo.upsertNode({ publicKey: KEY, lastHeard: 2_000 }, SOURCE);
    expect(await readLastHeard()).toBe(2_000);
  });

  it('still writes the first lastHeard when the stored value is null', async () => {
    // A node created from a contact record with no lastSeen yet.
    await repo.upsertNode({ publicKey: KEY, name: 'repeater' }, SOURCE);
    expect(await readLastHeard()).toBeFalsy();
    await repo.upsertNode({ publicKey: KEY, lastHeard: 5_000 }, SOURCE);
    expect(await readLastHeard()).toBe(5_000);
  });

  it('lets a stale write update its OTHER fields while leaving lastHeard alone', async () => {
    // The guard must be surgical. persistContact carries the node's name,
    // position and route alongside a stale lastSeen; dropping the whole write
    // would lose a rename.
    await repo.upsertNode({ publicKey: KEY, lastHeard: 9_000, name: 'old-name' }, SOURCE);
    await repo.upsertNode({ publicKey: KEY, lastHeard: 1_000, name: 'new-name' }, SOURCE);

    const node = await repo.getNodeByPublicKeyAndSource(KEY, SOURCE);
    expect(node?.name).toBe('new-name');
    expect(node?.lastHeard).toBe(9_000);
  });

  it('survives the exact #5131 sequence: telemetry stamp, then a stale contact sync', async () => {
    const advertTime = 1_700_000_000_000;          // node's last advert
    const telemetryTime = advertTime + 20 * 3600_000; // answered a poll 20h later

    // Contact sync seeds the row from the firmware's cached advert time.
    await repo.upsertNode({ publicKey: KEY, name: 'rarely-adverts', lastHeard: advertTime }, SOURCE);

    // Telemetry round-trip: the node answered us just now (#5132).
    await repo.markHeard(SOURCE, KEY, telemetryTime);
    expect(await readLastHeard()).toBe(telemetryTime);

    // The next contact refresh re-writes the SAME stale advert time. Before
    // the guard this clobbered the stamp and the node went "inactive" despite
    // having answered 0 seconds ago.
    await repo.upsertNode({ publicKey: KEY, name: 'rarely-adverts', lastHeard: advertTime }, SOURCE);
    expect(await readLastHeard()).toBe(telemetryTime);
  });

  // #5339: before ingest checked device clocks, a drifted sender RTC could
  // store a lastHeard years in the future. "Only forward" must not freeze
  // that value until the year it names.
  it('replaces a stored far-future lastHeard (drifted RTC) with a real observation (#5339)', async () => {
    const now = Date.now();
    const drifted = now + 60 * 365 * 24 * 3600_000; // ~60 years ahead
    await repo.upsertNode({ publicKey: KEY, lastHeard: drifted }, SOURCE);

    await repo.upsertNode({ publicKey: KEY, lastHeard: now }, SOURCE);
    expect(await readLastHeard()).toBe(now);
  });

  it('still keeps a stored lastHeard that is only slightly ahead (ordinary skew)', async () => {
    const now = Date.now();
    const skewed = now + 3600_000; // 1h ahead: within tolerance
    await repo.upsertNode({ publicKey: KEY, lastHeard: skewed }, SOURCE);

    await repo.upsertNode({ publicKey: KEY, lastHeard: now }, SOURCE);
    expect(await readLastHeard()).toBe(skewed);
  });
});

describe('MeshCoreRepository.markHeard (#5131)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MeshCoreRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new MeshCoreRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('creates the node row if this is the first thing we ever heard from it', async () => {
    await repo.markHeard(SOURCE, KEY, 4_000);
    const node = await repo.getNodeByPublicKeyAndSource(KEY, SOURCE);
    expect(node?.lastHeard).toBe(4_000);
  });

  it('scopes the stamp to the given source', async () => {
    await repo.markHeard(SOURCE, KEY, 4_000);
    // Same physical node observed through a different source is a different
    // row — hearing it on one source says nothing about the other.
    expect(await repo.getNodeByPublicKeyAndSource(KEY, 'src-b')).toBeFalsy();
  });

  it('ignores a non-finite or non-positive timestamp rather than writing junk', async () => {
    await repo.markHeard(SOURCE, KEY, Number.NaN);
    await repo.markHeard(SOURCE, KEY, 0);
    await repo.markHeard(SOURCE, KEY, -1);
    expect(await repo.getNodeByPublicKeyAndSource(KEY, SOURCE)).toBeFalsy();
  });
});
