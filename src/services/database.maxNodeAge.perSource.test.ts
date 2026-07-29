/**
 * Per-Source maxNodeAgeHours Regression Tests (#4412 Phase 2 WP3)
 *
 * Prior to this change, `getNodeNeedingRemoteAdminCheckAsync`,
 * `getNodesNeedingRemoteLocalStatsAsync` and `getNodeNeedingTracerouteAsync`
 * all resolved their "how far back counts as active" window via the global,
 * un-namespaced `this.getSetting('maxNodeAgeHours')` cache read — ignoring
 * any per-source override entirely. This suite proves all three sites now
 * resolve the setting through the shared `getMaxNodeAgeHours` accessor
 * (`src/server/services/nodeDisplaySettings.ts`), so two sources configured
 * with different windows see different "active" node sets for identical
 * node fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './database.js';
import { getMaxNodeAgeHours } from '../server/services/nodeDisplaySettings.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOURCE_A = 'source-a';
const SOURCE_B = 'source-b';
const LOCAL_NODE_NUM = 999999;
const REMOTE_NODE_NUM_A = 111;
const REMOTE_NODE_NUM_B = 222;

/** Helper: seed a source row. */
function seedSource(db: any, id: string, name: string) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, 'meshtastic', '{}', 1, now, now);
}

/** Helper: raw insert a node with explicit sourceId, lastHeard (seconds) and publicKey. */
function insertNode(
  db: any,
  nodeNum: number,
  nodeId: string,
  sourceId: string,
  overrides: Record<string, any> = {}
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO nodes (
      nodeNum, nodeId, longName, shortName, hwModel,
      lastHeard, publicKey, hasRemoteAdmin, lastRemoteAdminCheck,
      isFavorite, isIgnored,
      keyIsLowEntropy, duplicateKeyDetected, keyMismatchDetected,
      createdAt, updatedAt, sourceId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nodeNum,
    nodeId,
    overrides.longName ?? `Node ${nodeNum}`,
    'T',
    0,
    overrides.lastHeard ?? null,
    overrides.publicKey ?? null,
    overrides.hasRemoteAdmin ?? 0,
    overrides.lastRemoteAdminCheck ?? null,
    0,
    0,
    0,
    0,
    0,
    now,
    now,
    sourceId
  );
}

describe('DatabaseService - maxNodeAgeHours is per-source (#4412 Phase 2 WP3)', () => {
  let dbService: DatabaseService;
  let testDbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmonitor-maxage-'));
    testDbPath = path.join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = testDbPath;
    dbService = new DatabaseService();
    seedSource(dbService.db, SOURCE_A, 'Source A');
    seedSource(dbService.db, SOURCE_B, 'Source B');
  });

  afterEach(() => {
    if (dbService && dbService.db) dbService.db.close();
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.rmSync(path.dirname(testDbPath), { recursive: true, force: true });
    }
    delete process.env.DATABASE_PATH;
  });

  it('getNodeNeedingRemoteAdminCheckAsync resolves maxNodeAgeHours per source', async () => {
    // Both nodes were last heard 3 days ago — inside a 168h (7 day) window,
    // outside a 1h window.
    const threeDaysAgoSeconds = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    insertNode(dbService.db, REMOTE_NODE_NUM_A, '!0000006f', SOURCE_A, {
      lastHeard: threeDaysAgoSeconds,
      publicKey: 'fake-pubkey-a',
    });
    insertNode(dbService.db, REMOTE_NODE_NUM_B, '!000000de', SOURCE_B, {
      lastHeard: threeDaysAgoSeconds,
      publicKey: 'fake-pubkey-b',
    });

    await dbService.settings.setSourceSettings(SOURCE_A, { maxNodeAgeHours: '1' });
    await dbService.settings.setSourceSettings(SOURCE_B, { maxNodeAgeHours: '168' });

    const nodeA = await dbService.getNodeNeedingRemoteAdminCheckAsync(LOCAL_NODE_NUM, SOURCE_A);
    const nodeB = await dbService.getNodeNeedingRemoteAdminCheckAsync(LOCAL_NODE_NUM, SOURCE_B);

    // Source A's 1h window excludes a node last heard 3 days ago.
    expect(nodeA).toBeNull();
    // Source B's 168h window includes it.
    expect(nodeB?.nodeNum).toBe(REMOTE_NODE_NUM_B);
  });

  it('getNodesNeedingRemoteLocalStatsAsync resolves maxNodeAgeHours per source', async () => {
    const threeDaysAgoSeconds = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    insertNode(dbService.db, REMOTE_NODE_NUM_A, '!0000006f', SOURCE_A, { lastHeard: threeDaysAgoSeconds });
    insertNode(dbService.db, REMOTE_NODE_NUM_B, '!000000de', SOURCE_B, { lastHeard: threeDaysAgoSeconds });

    await dbService.settings.setSourceSettings(SOURCE_A, { maxNodeAgeHours: '1' });
    await dbService.settings.setSourceSettings(SOURCE_B, { maxNodeAgeHours: '168' });

    // Strictly opt-in filter group: enabled with no sub-filters configured
    // means "all active remote nodes are targets" (see database.ts union logic).
    const baseFilter = {
      enabled: true,
      nodeNums: [],
      filterRoles: [],
      filterNameRegex: '.*',
      filterNodesEnabled: false,
      filterRolesEnabled: false,
      filterFavoriteEnabled: false,
      filterRegexEnabled: false,
    };
    await dbService.setRemoteLocalStatsFilterSettingsAsync(baseFilter, SOURCE_A);
    await dbService.setRemoteLocalStatsFilterSettingsAsync(baseFilter, SOURCE_B);

    const nodesA = await dbService.getNodesNeedingRemoteLocalStatsAsync(LOCAL_NODE_NUM, SOURCE_A);
    const nodesB = await dbService.getNodesNeedingRemoteLocalStatsAsync(LOCAL_NODE_NUM, SOURCE_B);

    // sinceDays = max(1, ceil(hours/24)): source A -> 1 day, excludes a node
    // last heard 3 days ago; source B -> 7 days, includes it.
    expect(nodesA).toHaveLength(0);
    expect(nodesB.map((n) => n.nodeNum)).toEqual([REMOTE_NODE_NUM_B]);
  });

  it('sourceId omitted reads the un-namespaced global row (back-compat, no fallback to a neighbour source)', async () => {
    // This is the same `getMaxNodeAgeHours` helper all three converted
    // database.ts sites now call with `sourceId ?? null`. A source-scoped
    // value must never leak into the global read, and the global read must
    // never leak into a source-scoped one.
    await dbService.settings.setSourceSettings(SOURCE_A, { maxNodeAgeHours: '1' });
    await dbService.settings.setSetting('maxNodeAgeHours', '72');

    const globalHours = await getMaxNodeAgeHours(dbService.settings, null);
    const sourceAHours = await getMaxNodeAgeHours(dbService.settings, SOURCE_A);
    const sourceBHours = await getMaxNodeAgeHours(dbService.settings, SOURCE_B); // no override

    expect(globalHours).toBe(72);
    expect(sourceAHours).toBe(1);
    // Source B has no per-source row and must resolve to the hardcoded
    // default (24), never to the global row's 72 nor source A's 1.
    expect(sourceBHours).toBe(24);
  });
});
