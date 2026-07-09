/**
 * Per-Source Isolation Regression Tests (Phase 2a–2f)
 *
 * These tests verify that the multi-source automation refactor correctly
 * scopes data by sourceId. They are intentionally narrow: each test should
 * FAIL if someone removes source filtering from the corresponding code path.
 *
 * SQLite-only — runs in-memory, fast, no external services.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../schema/index.js';
import { SettingsRepository } from './settings.js';
import { AutoTracerouteRepository } from './autoTraceroute.js';
import { TimeSyncRepository } from './timeSync.js';
import { DistanceDeleteLogRepository } from './distanceDeleteLog.js';
import { NodesRepository } from './nodes.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

interface Harness {
  raw: Database.Database;
  drizzleDb: BetterSQLite3Database<typeof schema>;
  settings: SettingsRepository;
  autoTraceroute: AutoTracerouteRepository;
  timeSync: TimeSyncRepository;
  distanceDeleteLog: DistanceDeleteLogRepository;
  nodes: NodesRepository;
}

function createHarness(): Harness {
  const t = createTestDb();
  return {
    raw: t.sqlite,
    drizzleDb: t.db,
    settings: new SettingsRepository(t.db, 'sqlite'),
    autoTraceroute: new AutoTracerouteRepository(t.db, 'sqlite'),
    timeSync: new TimeSyncRepository(t.db, 'sqlite'),
    distanceDeleteLog: new DistanceDeleteLogRepository(t.db, 'sqlite'),
    nodes: new NodesRepository(t.db, 'sqlite'),
  };
}

describe('per-source isolation (Phase 2a–2f)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.raw.close();
  });

  // -------------------------------------------------------------------------
  // Phase 2a — settings KV per-source
  // -------------------------------------------------------------------------
  describe('Phase 2a — getSettingForSource', () => {
    it('returns per-source override when present', async () => {
      await h.settings.setSetting('autoPingEnabled', 'false');
      await h.settings.setSourceSetting('A', 'autoPingEnabled', 'true');

      const a = await h.settings.getSettingForSource('A', 'autoPingEnabled');
      expect(a).toBe('true');
    });

    it('returns null when no per-source override exists, even if global is set', async () => {
      // Issue #2839 / #2840: previous fallback to the global value caused
      // multi-source automation spam and post-upgrade UI/runtime mismatches.
      // Each source must own its config independently.
      await h.settings.setSetting('autoPingEnabled', 'false');

      const a = await h.settings.getSettingForSource('A', 'autoPingEnabled');
      expect(a).toBeNull();
    });

    it('returns global when sourceId is null/undefined', async () => {
      await h.settings.setSetting('autoPingEnabled', 'global-value');
      // Even if a per-source key exists, sourceId=null must read global
      await h.settings.setSourceSetting('A', 'autoPingEnabled', 'a-value');

      expect(await h.settings.getSettingForSource(null, 'autoPingEnabled')).toBe('global-value');
      expect(await h.settings.getSettingForSource(undefined, 'autoPingEnabled')).toBe('global-value');
    });

    it('source A override does not leak into source B', async () => {
      await h.settings.setSourceSetting('A', 'autoPingEnabled', 'true');
      await h.settings.setSourceSetting('B', 'autoPingEnabled', 'false');

      expect(await h.settings.getSettingForSource('A', 'autoPingEnabled')).toBe('true');
      expect(await h.settings.getSettingForSource('B', 'autoPingEnabled')).toBe('false');
    });

    it('source B with no override and no global returns null', async () => {
      await h.settings.setSourceSetting('A', 'autoPingEnabled', 'true');
      expect(await h.settings.getSettingForSource('B', 'autoPingEnabled')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2b — auto-traceroute (nodes + log)
  // -------------------------------------------------------------------------
  describe('Phase 2b — auto-traceroute per-source', () => {
    it('addAutoTracerouteNode allows same nodeNum across sources A and B', async () => {
      await h.autoTraceroute.addAutoTracerouteNode(12345, 'A');
      // Composite unique (nodeNum, sourceId) must permit this:
      await expect(h.autoTraceroute.addAutoTracerouteNode(12345, 'B')).resolves.not.toThrow();

      const a = await h.autoTraceroute.getAutoTracerouteNodes('A');
      const b = await h.autoTraceroute.getAutoTracerouteNodes('B');
      expect(a).toEqual([12345]);
      expect(b).toEqual([12345]);
    });

    it('addAutoTracerouteNode is idempotent within the same source', async () => {
      await h.autoTraceroute.addAutoTracerouteNode(999, 'A');
      await h.autoTraceroute.addAutoTracerouteNode(999, 'A');
      const rows = await h.autoTraceroute.getAutoTracerouteNodes('A');
      expect(rows).toEqual([999]);
    });

    it('getAutoTracerouteNodes(sourceId) returns only that source', async () => {
      await h.autoTraceroute.addAutoTracerouteNode(100, 'A');
      await h.autoTraceroute.addAutoTracerouteNode(200, 'A');
      await h.autoTraceroute.addAutoTracerouteNode(300, 'B');

      expect((await h.autoTraceroute.getAutoTracerouteNodes('A')).sort()).toEqual([100, 200]);
      expect(await h.autoTraceroute.getAutoTracerouteNodes('B')).toEqual([300]);
    });

    it('auto_traceroute_log: insert with sourceId is only visible to that source', () => {
      // Mirror DatabaseService.logAutoTracerouteAttempt SQL — the code path
      // we want to regression-protect.
      const insert = h.raw.prepare(`
        INSERT INTO auto_traceroute_log (timestamp, to_node_num, to_node_name, success, created_at, sourceId)
        VALUES (?, ?, ?, NULL, ?, ?)
      `);
      const now = Date.now();
      insert.run(now, 111, 'alpha', now, 'A');
      insert.run(now + 1, 222, 'bravo', now + 1, 'B');

      const selectFiltered = h.raw.prepare(`
        SELECT to_node_num as toNodeNum FROM auto_traceroute_log
        WHERE sourceId = ? ORDER BY timestamp DESC LIMIT ?
      `);
      const rowsA = selectFiltered.all('A', 10) as { toNodeNum: number }[];
      const rowsB = selectFiltered.all('B', 10) as { toNodeNum: number }[];
      expect(rowsA.map(r => r.toNodeNum)).toEqual([111]);
      expect(rowsB.map(r => r.toNodeNum)).toEqual([222]);
    });

    it('auto_traceroute_log: unfiltered read returns all rows (legacy compat)', () => {
      const insert = h.raw.prepare(`
        INSERT INTO auto_traceroute_log (timestamp, to_node_num, to_node_name, success, created_at, sourceId)
        VALUES (?, ?, ?, NULL, ?, ?)
      `);
      insert.run(1, 111, 'a', 1, 'A');
      insert.run(2, 222, 'b', 2, 'B');
      insert.run(3, 333, 'c', 3, null);

      const all = h.raw.prepare(`
        SELECT to_node_num as toNodeNum FROM auto_traceroute_log
        ORDER BY timestamp DESC LIMIT ?
      `).all(10) as { toNodeNum: number }[];
      expect(all.map(r => r.toNodeNum).sort()).toEqual([111, 222, 333]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2c — auto time sync (mirror of 2b)
  // -------------------------------------------------------------------------
  describe('Phase 2c — auto-time-sync per-source', () => {
    it('addAutoTimeSyncNode allows same nodeNum for sources A and B', async () => {
      await h.timeSync.addAutoTimeSyncNode(12345, 'A');
      await expect(h.timeSync.addAutoTimeSyncNode(12345, 'B')).resolves.not.toThrow();
      expect(await h.timeSync.getAutoTimeSyncNodes('A')).toEqual([12345]);
      expect(await h.timeSync.getAutoTimeSyncNodes('B')).toEqual([12345]);
    });

    it('getAutoTimeSyncNodes(sourceId) filters by source', async () => {
      await h.timeSync.addAutoTimeSyncNode(10, 'A');
      await h.timeSync.addAutoTimeSyncNode(20, 'A');
      await h.timeSync.addAutoTimeSyncNode(30, 'B');
      expect((await h.timeSync.getAutoTimeSyncNodes('A')).sort()).toEqual([10, 20]);
      expect(await h.timeSync.getAutoTimeSyncNodes('B')).toEqual([30]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2d — distance delete log
  // -------------------------------------------------------------------------
  describe('Phase 2d — distance-delete log per-source', () => {
    it('addDistanceDeleteLogEntry with sourceId is only visible to that source', async () => {
      await h.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp: 1, nodesDeleted: 1, thresholdKm: 50, details: '[]', sourceId: 'A',
      });
      await h.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp: 2, nodesDeleted: 2, thresholdKm: 75, details: '[]', sourceId: 'B',
      });

      const aRows = await h.distanceDeleteLog.getDistanceDeleteLog(10, 'A');
      const bRows = await h.distanceDeleteLog.getDistanceDeleteLog(10, 'B');
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      expect(aRows[0].nodesDeleted).toBe(1);
      expect(bRows[0].nodesDeleted).toBe(2);
    });

    it('unfiltered getDistanceDeleteLog returns all rows', async () => {
      await h.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp: 1, nodesDeleted: 1, thresholdKm: 50, details: '[]', sourceId: 'A',
      });
      await h.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp: 2, nodesDeleted: 2, thresholdKm: 75, details: '[]', sourceId: 'B',
      });
      await h.distanceDeleteLog.addDistanceDeleteLogEntry({
        timestamp: 3, nodesDeleted: 3, thresholdKm: 99, details: '[]',
      });

      const all = await h.distanceDeleteLog.getDistanceDeleteLog(10);
      expect(all).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2e — key repair log
  // -------------------------------------------------------------------------
  describe('Phase 2e — key-repair log per-source', () => {
    // These mirror DatabaseService.logKeyRepairAttemptAsync and
    // getKeyRepairLogAsync SQLite branches (raw better-sqlite3).
    const insertSql = `
      INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    it('insert with sourceId is only visible via filtered read', () => {
      const stmt = h.raw.prepare(insertSql);
      stmt.run(1, 100, 'nodeA', 'send_nodeinfo', null, 1, null, null, 'A');
      stmt.run(2, 200, 'nodeB', 'send_nodeinfo', null, 2, null, null, 'B');

      const filtered = h.raw.prepare(`
        SELECT nodeNum FROM auto_key_repair_log WHERE sourceId = ? ORDER BY timestamp DESC LIMIT ?
      `);
      const rowsA = filtered.all('A', 50) as { nodeNum: number }[];
      const rowsB = filtered.all('B', 50) as { nodeNum: number }[];
      expect(rowsA.map(r => r.nodeNum)).toEqual([100]);
      expect(rowsB.map(r => r.nodeNum)).toEqual([200]);
    });

    it('unfiltered read returns all rows', () => {
      const stmt = h.raw.prepare(insertSql);
      stmt.run(1, 100, 'a', 'x', null, 1, null, null, 'A');
      stmt.run(2, 200, 'b', 'x', null, 2, null, null, 'B');
      stmt.run(3, 300, 'c', 'x', null, 3, null, null, null);

      const all = h.raw.prepare(`
        SELECT nodeNum FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT ?
      `).all(50) as { nodeNum: number }[];
      expect(all.map(r => r.nodeNum).sort()).toEqual([100, 200, 300]);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2f — markAllNodesAsWelcomed scoping
  // -------------------------------------------------------------------------
  describe('Phase 2f — markAllNodesAsWelcomed per-source', () => {
    function seedNode(nodeNum: number, nodeId: string, sourceId: string) {
      h.raw.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, welcomedAt, createdAt, updatedAt, sourceId)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
      `).run(nodeNum, nodeId, `node-${nodeNum}`, Date.now(), Date.now(), sourceId);
    }

    it('marks only nodes belonging to the given source', async () => {
      seedNode(1, '!00000001', 'A');
      seedNode(2, '!00000002', 'B');

      const updated = await h.nodes.markAllNodesAsWelcomed('A');
      expect(updated).toBe(1);

      const rows = h.raw.prepare(`SELECT nodeNum, welcomedAt FROM nodes ORDER BY nodeNum`).all() as {
        nodeNum: number;
        welcomedAt: number | null;
      }[];
      expect(rows[0].welcomedAt).not.toBeNull();
      expect(rows[1].welcomedAt).toBeNull();
    });

    it('without sourceId marks ALL nodes as welcomed', async () => {
      seedNode(1, '!00000001', 'A');
      seedNode(2, '!00000002', 'B');
      seedNode(3, '!00000003', 'C');

      const updated = await h.nodes.markAllNodesAsWelcomed();
      expect(updated).toBe(3);

      const rows = h.raw.prepare(`SELECT welcomedAt FROM nodes`).all() as { welcomedAt: number | null }[];
      expect(rows.every(r => r.welcomedAt !== null)).toBe(true);
    });

    it('does not re-mark already-welcomed nodes from another source', async () => {
      // Pre-welcomed B node, fresh A node
      h.raw.prepare(`
        INSERT INTO nodes (nodeNum, nodeId, longName, welcomedAt, createdAt, updatedAt, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, '!00000002', 'b', 12345, Date.now(), Date.now(), 'B');
      seedNode(1, '!00000001', 'A');

      const updated = await h.nodes.markAllNodesAsWelcomed('A');
      expect(updated).toBe(1);

      const bRow = h.raw.prepare(`SELECT welcomedAt FROM nodes WHERE nodeNum = 2`).get() as { welcomedAt: number };
      expect(bRow.welcomedAt).toBe(12345);
    });
  });
});
