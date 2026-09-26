/**
 * #5364/#5365 Phase 1 WP1 — likely-aircraft classification repository
 * methods, per-source isolation.
 *
 * Same `nodeNum` in sources A and B is routine on a mesh with multiple
 * gateways. A leak here would let one source's classification (or its clear)
 * bleed into another source's view of the "same" physical node.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NodesRepository } from './nodes.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

const SOURCE_A = 'src-a';
const SOURCE_B = 'src-b';

function makeNode(nodeNum: number, overrides: Record<string, unknown> = {}) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    ...overrides,
  };
}

describe('NodesRepository aircraft classification - per-source isolation', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: NodesRepository;

  function setup() {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    repo = new NodesRepository(drizzleDb as any, 'sqlite');
  }

  afterEach(() => {
    if (db) db.close();
  });

  it('a write to source A leaves the same nodeNum in source B null', async () => {
    setup();
    await repo.upsertNode(makeNode(100, { altitude: 3200 }), SOURCE_A);
    await repo.upsertNode(makeNode(100, { altitude: 3200 }), SOURCE_B);

    await repo.setAircraftClassification(100, SOURCE_A, {
      likelyAircraft: true,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
      aircraftClassifiedAt: Date.now(),
    });

    const nodeA = await repo.getNode(100, SOURCE_A);
    const nodeB = await repo.getNode(100, SOURCE_B);
    expect(nodeA?.likelyAircraft).toBe(true);
    expect(nodeB?.likelyAircraft).toBeNull();
    expect(nodeB?.aircraftBasis).toBeNull();
  });

  it('clearAircraftClassification(A) leaves source B\'s classification untouched', async () => {
    setup();
    await repo.upsertNode(makeNode(200, { altitude: 3200 }), SOURCE_A);
    await repo.upsertNode(makeNode(200, { altitude: 3200 }), SOURCE_B);

    for (const sourceId of [SOURCE_A, SOURCE_B]) {
      await repo.setAircraftClassification(200, sourceId, {
        likelyAircraft: true,
        aircraftBasis: 'agl',
        groundElevation: 200,
        heightAboveGround: 3000,
        aircraftClassifiedAt: Date.now(),
      });
    }

    const affected = await repo.clearAircraftClassification(SOURCE_A);
    expect(affected).toBe(1);

    const nodeA = await repo.getNode(200, SOURCE_A);
    const nodeB = await repo.getNode(200, SOURCE_B);
    expect(nodeA?.likelyAircraft).toBeNull();
    expect(nodeB?.likelyAircraft).toBe(true);
    expect(nodeB?.aircraftBasis).toBe('agl');
  });

  it('getUnclassifiedNodeNumsWithAltitude(A) excludes source B\'s rows, even the same nodeNum', async () => {
    setup();
    // Same nodeNum on both sources; only B has been classified.
    await repo.upsertNode(makeNode(300, { altitude: 3200 }), SOURCE_A);
    await repo.upsertNode(makeNode(300, { altitude: 3200 }), SOURCE_B);
    await repo.setAircraftClassification(300, SOURCE_B, {
      likelyAircraft: true,
      aircraftBasis: 'agl',
      groundElevation: 200,
      heightAboveGround: 3000,
      aircraftClassifiedAt: Date.now(),
    });
    // A node that exists only on source B, unclassified — must never appear
    // in A's list, only in B's.
    await repo.upsertNode(makeNode(301, { altitude: 500 }), SOURCE_B);

    const idsA = await repo.getUnclassifiedNodeNumsWithAltitude(SOURCE_A);
    const idsB = await repo.getUnclassifiedNodeNumsWithAltitude(SOURCE_B);
    expect(idsA).toEqual([300]);
    expect(idsA).not.toContain(301);
    expect(idsB).toEqual([301]);
  });

  it('getAircraftReclassifyRows(A) never returns source B\'s row for the same nodeNum', async () => {
    setup();
    await repo.upsertNode(makeNode(400, { altitude: 3200 }), SOURCE_A);
    await repo.upsertNode(makeNode(400, { altitude: 500 }), SOURCE_B);

    const rowsA = await repo.getAircraftReclassifyRows(SOURCE_A);
    expect(rowsA.map((r) => r.nodeNum)).toEqual([400]);
    expect(rowsA[0].altitude).toBe(3200);
  });
});
