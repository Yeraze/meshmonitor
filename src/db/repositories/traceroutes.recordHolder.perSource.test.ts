/**
 * `#5101` route_segments record-holder — per-source isolation.
 *
 * `updateRecordHolderIfLonger` / `getRecordHolderRouteSegment` /
 * `clearRecordHolderBySource` all take a `sourceId` alongside the transport
 * class. This asserts a write or clear scoped to (source A, rf) never
 * touches source A's mqtt record or source B's records of either class —
 * records are now kept per (source, transport class), and neither axis may
 * leak into the other. Also pins the `withSourceScope` guard: a bare empty
 * string must still throw, matching every other scoped repository method.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TraceroutesRepository } from './traceroutes.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import type { DbRouteSegment } from '../types.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';
const NOW = 1_760_000_000_000;

function makeSegment(
  fromNodeNum: number,
  toNodeNum: number,
  distanceKm: number,
  transportMechanism: number,
  timestamp: number = NOW,
): DbRouteSegment {
  return {
    fromNodeNum,
    toNodeNum,
    fromNodeId: `!${fromNodeNum.toString(16).padStart(8, '0')}`,
    toNodeId: `!${toNodeNum.toString(16).padStart(8, '0')}`,
    distanceKm,
    isRecordHolder: false,
    transportMechanism,
    timestamp,
    createdAt: timestamp,
  };
}

describe('TraceroutesRepository — record-holder per-source isolation (#5101)', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: TraceroutesRepository;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new TraceroutesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  it('sources A and B each keep independent RF and MQTT records', async () => {
    await repo.updateRecordHolderIfLonger(makeSegment(1001, 1002, 10, 1), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(1003, 1004, 20, 5), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(2001, 2002, 99, 1), SOURCE_B);
    await repo.updateRecordHolderIfLonger(makeSegment(2003, 2004, 88, 5), SOURCE_B);

    const rfA = await repo.getRecordHolderRouteSegment(SOURCE_A, 'rf');
    const mqttA = await repo.getRecordHolderRouteSegment(SOURCE_A, 'mqtt');
    const rfB = await repo.getRecordHolderRouteSegment(SOURCE_B, 'rf');
    const mqttB = await repo.getRecordHolderRouteSegment(SOURCE_B, 'mqtt');

    expect(rfA!.distanceKm).toBeCloseTo(10);
    expect(mqttA!.distanceKm).toBeCloseTo(20);
    expect(rfB!.distanceKm).toBeCloseTo(99);
    expect(mqttB!.distanceKm).toBeCloseTo(88);
  });

  it('updateRecordHolderIfLonger on (A, rf) does not touch (A, mqtt), (B, rf) or (B, mqtt)', async () => {
    await repo.updateRecordHolderIfLonger(makeSegment(1001, 1002, 10, 1), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(1003, 1004, 20, 5), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(2001, 2002, 99, 1), SOURCE_B);
    await repo.updateRecordHolderIfLonger(makeSegment(2003, 2004, 88, 5), SOURCE_B);

    // A longer RF segment on source A only.
    await repo.updateRecordHolderIfLonger(makeSegment(1005, 1006, 50, 1, NOW + 1), SOURCE_A);

    expect((await repo.getRecordHolderRouteSegment(SOURCE_A, 'rf'))!.distanceKm).toBeCloseTo(50);
    expect((await repo.getRecordHolderRouteSegment(SOURCE_A, 'mqtt'))!.distanceKm).toBeCloseTo(20);
    expect((await repo.getRecordHolderRouteSegment(SOURCE_B, 'rf'))!.distanceKm).toBeCloseTo(99);
    expect((await repo.getRecordHolderRouteSegment(SOURCE_B, 'mqtt'))!.distanceKm).toBeCloseTo(88);
  });

  it('clearRecordHolderBySource(A, "rf") does not touch (A, mqtt), (B, rf) or (B, mqtt)', async () => {
    await repo.updateRecordHolderIfLonger(makeSegment(1001, 1002, 10, 1), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(1003, 1004, 20, 5), SOURCE_A);
    await repo.updateRecordHolderIfLonger(makeSegment(2001, 2002, 99, 1), SOURCE_B);
    await repo.updateRecordHolderIfLonger(makeSegment(2003, 2004, 88, 5), SOURCE_B);

    await repo.clearRecordHolderBySource(SOURCE_A, 'rf');

    expect(await repo.getRecordHolderRouteSegment(SOURCE_A, 'rf')).toBeNull();
    expect((await repo.getRecordHolderRouteSegment(SOURCE_A, 'mqtt'))!.distanceKm).toBeCloseTo(20);
    expect((await repo.getRecordHolderRouteSegment(SOURCE_B, 'rf'))!.distanceKm).toBeCloseTo(99);
    expect((await repo.getRecordHolderRouteSegment(SOURCE_B, 'mqtt'))!.distanceKm).toBeCloseTo(88);
  });

  it('sourceId "" throws (withSourceScope guard)', async () => {
    await expect(repo.getRecordHolderRouteSegment('', 'rf')).rejects.toThrow(/sourceId is required/);
    await expect(repo.clearRecordHolderBySource('', 'rf')).rejects.toThrow(/sourceId is required/);
    await expect(
      repo.updateRecordHolderIfLonger(makeSegment(1001, 1002, 10, 1), ''),
    ).rejects.toThrow(/sourceId is required/);
  });

  it('sourceId undefined throws too (matches sibling scoped methods)', async () => {
    await expect(repo.getRecordHolderRouteSegment(undefined, 'rf')).rejects.toThrow(/sourceId is required/);
  });
});
