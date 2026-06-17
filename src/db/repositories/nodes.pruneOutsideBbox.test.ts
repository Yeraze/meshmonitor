/**
 * NodesRepository.pruneNodesOutsideBbox tests.
 *
 * SQLite-only because the Drizzle query (eq + isNotNull + or(lt, gt))
 * compiles to the same logical SQL on Postgres/MySQL via the shared
 * schema definitions. If we ever add a per-backend codepath here, copy
 * the multi-backend describe pattern from nodes.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodesRepository } from './nodes.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';
import {
  TestBackend,
} from './test-utils.js';

// Florida bbox roughly matching the Florida MQTT bridge config in production.
const FL_BBOX = { minLat: 24.33, maxLat: 27.53, minLng: -81.30, maxLng: -77.67 };
const BRIDGE_ID = 'bridge-florida';
const OTHER_BRIDGE_ID = 'bridge-other';

function makePositionedNode(
  nodeNum: number,
  lat: number | null,
  lng: number | null,
  sourceId: string = BRIDGE_ID,
) {
  return {
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    latitude: lat ?? undefined,
    longitude: lng ?? undefined,
    sourceId,
  };
}

describe('NodesRepository.pruneNodesOutsideBbox', () => {
  let testDb: TestDb;
  let backend: TestBackend;
  let repo: NodesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: testDb.db,
      exec: async (sql: string) => { testDb.sqlite.exec(sql); },
      close: async () => { testDb.close(); },
      available: true,
    };
    repo = new NodesRepository(backend.drizzleDb, backend.dbType);
  });

  afterEach(async () => {
    await backend.close();
  });

  it('deletes nodes outside the bbox for the target sourceId and returns the count', async () => {
    // Inside Florida bbox: Tampa-ish, Miami-ish.
    await repo.upsertNode(makePositionedNode(101, 27.95, -82.45)); // outside (lng < minLng)
    await repo.upsertNode(makePositionedNode(102, 25.76, -80.19)); // INSIDE (Miami)
    // Way outside: Pensacola, Jacksonville.
    await repo.upsertNode(makePositionedNode(103, 30.42, -87.22));
    await repo.upsertNode(makePositionedNode(104, 30.33, -81.66));
    // Borderline cases on the south/north edges (inclusive).
    await repo.upsertNode(makePositionedNode(105, 24.33, -80.00)); // minLat boundary → inside
    await repo.upsertNode(makePositionedNode(106, 27.53, -80.00)); // maxLat boundary → inside

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, FL_BBOX);
    expect(deleted).toBe(3); // 101, 103, 104

    expect(await repo.getNode(101, BRIDGE_ID)).toBeNull();
    expect(await repo.getNode(103, BRIDGE_ID)).toBeNull();
    expect(await repo.getNode(104, BRIDGE_ID)).toBeNull();
    expect(await repo.getNode(102, BRIDGE_ID)).not.toBeNull();
    expect(await repo.getNode(105, BRIDGE_ID)).not.toBeNull();
    expect(await repo.getNode(106, BRIDGE_ID)).not.toBeNull();
  });

  it('keeps nodes with no recorded position (we have no evidence they are outside)', async () => {
    await repo.upsertNode(makePositionedNode(201, null, null));
    // Position-less rows still need a non-zero lastHeard to be useful in
    // production, but for the prune query only lat/lng matter.

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, FL_BBOX);
    expect(deleted).toBe(0);
    expect(await repo.getNode(201, BRIDGE_ID)).not.toBeNull();
  });

  it('never touches nodes belonging to a different sourceId', async () => {
    // Same lat/lng, two different sources — only the target bridge is pruned.
    await repo.upsertNode(makePositionedNode(301, 30.42, -87.22, BRIDGE_ID));
    await repo.upsertNode(makePositionedNode(301, 30.42, -87.22, OTHER_BRIDGE_ID));

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, FL_BBOX);
    expect(deleted).toBe(1);
    expect(await repo.getNode(301, BRIDGE_ID)).toBeNull();
    expect(await repo.getNode(301, OTHER_BRIDGE_ID)).not.toBeNull();
  });

  it('returns 0 and does nothing when the bbox has no defined bounds (defensive)', async () => {
    await repo.upsertNode(makePositionedNode(401, 30.42, -87.22)); // would be outside any FL bbox

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, {});
    expect(deleted).toBe(0);
    expect(await repo.getNode(401, BRIDGE_ID)).not.toBeNull();
  });

  it('honors partial bbox bounds — e.g. lat-only check still prunes lat violators', async () => {
    await repo.upsertNode(makePositionedNode(501, 30.42, -150.00)); // lat outside, lng ignored
    await repo.upsertNode(makePositionedNode(502, 26.00, -150.00)); // lat inside, lng ignored

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, {
      minLat: 24.33,
      maxLat: 27.53,
    });
    expect(deleted).toBe(1);
    expect(await repo.getNode(501, BRIDGE_ID)).toBeNull();
    expect(await repo.getNode(502, BRIDGE_ID)).not.toBeNull();
  });

  it('returns 0 when all nodes are inside the bbox', async () => {
    await repo.upsertNode(makePositionedNode(601, 25.76, -80.19));
    await repo.upsertNode(makePositionedNode(602, 26.50, -80.50));

    const deleted = await repo.pruneNodesOutsideBbox(BRIDGE_ID, FL_BBOX);
    expect(deleted).toBe(0);
    expect(await repo.getNode(601, BRIDGE_ID)).not.toBeNull();
    expect(await repo.getNode(602, BRIDGE_ID)).not.toBeNull();
  });
});
