/**
 * MeshCore packet log — query-time dedup of per-observer receptions
 * (#5040 Phase 2).
 *
 * A `meshcore_mqtt` source writes ONE ROW PER OBSERVER that heard a frame, so
 * the raw table is a reception log. These tests pin the collapsed read view:
 * one entry per distinct frame, carrying how many observers heard it and the
 * best signal any of them reported.
 *
 * The failure this guards against is silent: if the grouping key or the
 * DISTINCT were wrong, the monitor would either show the same packet eight
 * times or under-report coverage, and neither looks like an error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MeshCoreRepository, type DbMeshCorePacket } from './meshcore.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const FRAME_A = '0500deadbeef';
const FRAME_B = '0500cafebabe';
const OBS_1 = 'AA'.repeat(32);
const OBS_2 = 'BB'.repeat(32);
const OBS_3 = 'CC'.repeat(32);

function makePacket(sourceId: string, overrides: Partial<DbMeshCorePacket> = {}): DbMeshCorePacket {
  const now = 1_700_000_000_000;
  return {
    sourceId,
    timestamp: now,
    payloadType: 0x02,
    payloadTypeName: 'TXT_MSG',
    routeType: 0x01,
    routeTypeName: 'FLOOD',
    pathLenRaw: 0x41,
    hopCount: 1,
    pathHops: 'a3',
    snr: 6.25,
    rssi: -42,
    payloadSize: 24,
    rawHex: FRAME_A,
    createdAt: now,
    ...overrides,
  };
}

describe('MeshCoreRepository — grouped packet queries (#5040)', () => {
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

  it('collapses three observer receptions of one frame into a single row', async () => {
    for (const [i, obs] of [OBS_1, OBS_2, OBS_3].entries()) {
      await repo.insertPacket(
        makePacket('src-mqtt', { observerId: obs, timestamp: 1000 + i, snr: 1 + i }),
      );
    }

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      rawHex: FRAME_A,
      observerCount: 3,
      receptionCount: 3,
    });
  });

  it('reports the BEST signal any observer heard, not an arbitrary one', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, snr: -12, rssi: -120 }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_2, snr: 4.5, rssi: -80 }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_3, snr: -3, rssi: -99 }));

    const [g] = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(g.bestSnr).toBe(4.5);
    // "Best" RSSI is the least negative.
    expect(g.bestRssi).toBe(-80);
  });

  it('spans first and last heard across the group', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, timestamp: 5000 }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_2, timestamp: 9000 }));

    const [g] = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(g.firstHeard).toBe(5000);
    expect(g.lastHeard).toBe(9000);
  });

  it('keeps distinct frames separate', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, rawHex: FRAME_A }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_2, rawHex: FRAME_A }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, rawHex: FRAME_B }));

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(grouped).toHaveLength(2);
    expect(grouped.map((g) => g.rawHex).sort()).toEqual([FRAME_B, FRAME_A].sort());
  });

  it('never groups across sources', async () => {
    // Same frame bytes on two sources are two different observations of the
    // mesh, and per-source scoping is a hard rule.
    await repo.insertPacket(makePacket('src-a', { observerId: OBS_1 }));
    await repo.insertPacket(makePacket('src-b', { observerId: OBS_1 }));

    expect(await repo.getGroupedPackets({ sourceId: 'src-a' })).toHaveLength(1);
    expect(await repo.getGroupedPackets({ sourceId: 'src-b' })).toHaveLength(1);
  });

  it('reports observerCount 0 for a locally-heard frame', async () => {
    // A device-backed source leaves observerId NULL — nobody ELSE heard it, we
    // did. COUNT(DISTINCT) skips NULLs, which is the intended reading.
    await repo.insertPacket(makePacket('src-device', { observerId: null }));

    const [g] = await repo.getGroupedPackets({ sourceId: 'src-device' });
    expect(g.observerCount).toBe(0);
    expect(g.receptionCount).toBe(1);
  });

  it('does not collapse distinct frames that both lack a rawHex', async () => {
    // Without a frame identity there is nothing to group on, so each row must
    // stay its own group rather than merging into one bogus entry.
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: null, observerId: OBS_1 }));
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: null, observerId: OBS_2 }));

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(grouped).toHaveLength(2);
  });

  it('counts groups, not rows', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, rawHex: FRAME_A }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_2, rawHex: FRAME_A }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, rawHex: FRAME_B }));

    expect(await repo.getGroupedPacketCount({ sourceId: 'src-mqtt' })).toBe(2);
    // The raw reception count is still 3 — the collapsed view is a read
    // concern, the table keeps every reception.
    expect(await repo.getPacketCount({ sourceId: 'src-mqtt' })).toBe(3);
  });

  it('orders groups newest-first by their most recent reception', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_A, observerId: OBS_1, timestamp: 100 }));
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_B, observerId: OBS_1, timestamp: 200 }));
    // A late reception of the OLDER frame lifts it back to the top.
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_A, observerId: OBS_2, timestamp: 300 }));

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt' });
    expect(grouped.map((g) => g.rawHex)).toEqual([FRAME_A, FRAME_B]);
  });

  it('honours the existing filters', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_A, payloadType: 0x02 }));
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_B, payloadType: 0x09 }));

    const grouped = await repo.getGroupedPackets({ sourceId: 'src-mqtt', payloadType: 0x09 });
    expect(grouped).toHaveLength(1);
    expect(grouped[0].rawHex).toBe(FRAME_B);
  });

  it('expands a group back into its per-observer receptions', async () => {
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_1, timestamp: 200, snr: 1 }));
    await repo.insertPacket(makePacket('src-mqtt', { observerId: OBS_2, timestamp: 100, snr: 2 }));
    await repo.insertPacket(makePacket('src-mqtt', { rawHex: FRAME_B, observerId: OBS_3 }));

    const receptions = await repo.getPacketReceptions('src-mqtt', FRAME_A);
    expect(receptions).toHaveLength(2);
    // Oldest-first.
    expect(receptions.map((r) => r.observerId)).toEqual([OBS_2, OBS_1]);
  });
});
