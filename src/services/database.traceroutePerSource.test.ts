/**
 * Per-Source Auto-Traceroute Filter Regression Tests
 *
 * Verifies that getTracerouteFilterSettingsAsync and
 * setTracerouteFilterSettingsAsync correctly scope every filter field by
 * sourceId. Prior to this fix, only the `nodeNums` list was per-source;
 * all other filter fields (channels, roles, hwModels, regex, last-heard,
 * hop range, expiration hours, sort-by-hops, individual enabled flags,
 * and the master "enabled" toggle) were stored as global settings, so
 * configuring filters on one Source silently overwrote them on every
 * other Source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SOURCE_A = 'source-a';
const SOURCE_B = 'source-b';

function seedSource(db: any, id: string, name: string) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, name, type, config, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, 'meshtastic', '{}', 1, now, now);
}

describe('DatabaseService - per-source auto-traceroute filters', () => {
  let dbService: DatabaseService;
  let testDbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmonitor-trfilter-'));
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

  it('writes and reads independent filter configurations per source', async () => {
    await dbService.setTracerouteFilterSettingsAsync(
      {
        enabled: true,
        nodeNums: [111, 222],
        filterChannels: [0, 1],
        filterRoles: [1],
        filterHwModels: [31],
        filterNameRegex: 'alpha.*',
        filterNodesEnabled: true,
        filterChannelsEnabled: true,
        filterRolesEnabled: false,
        filterHwModelsEnabled: false,
        filterRegexEnabled: true,
        expirationHours: 12,
        sortByHops: true,
        filterLastHeardEnabled: true,
        filterLastHeardHours: 24,
        filterHopsEnabled: true,
        filterHopsMin: 1,
        filterHopsMax: 3,
      },
      SOURCE_A,
    );

    await dbService.setTracerouteFilterSettingsAsync(
      {
        enabled: false,
        nodeNums: [333],
        filterChannels: [7],
        filterRoles: [2, 3],
        filterHwModels: [],
        filterNameRegex: 'bravo.*',
        filterNodesEnabled: false,
        filterChannelsEnabled: false,
        filterRolesEnabled: true,
        filterHwModelsEnabled: true,
        filterRegexEnabled: false,
        expirationHours: 48,
        sortByHops: false,
        filterLastHeardEnabled: false,
        filterLastHeardHours: 168,
        filterHopsEnabled: false,
        filterHopsMin: 5,
        filterHopsMax: 9,
      },
      SOURCE_B,
    );

    const a = await dbService.getTracerouteFilterSettingsAsync(SOURCE_A);
    const b = await dbService.getTracerouteFilterSettingsAsync(SOURCE_B);

    expect(a.enabled).toBe(true);
    expect(a.nodeNums.sort()).toEqual([111, 222]);
    expect(a.filterChannels.sort()).toEqual([0, 1]);
    expect(a.filterRoles).toEqual([1]);
    expect(a.filterHwModels).toEqual([31]);
    expect(a.filterNameRegex).toBe('alpha.*');
    expect(a.filterRolesEnabled).toBe(false);
    expect(a.filterRegexEnabled).toBe(true);
    expect(a.expirationHours).toBe(12);
    expect(a.sortByHops).toBe(true);
    expect(a.filterLastHeardEnabled).toBe(true);
    expect(a.filterLastHeardHours).toBe(24);
    expect(a.filterHopsEnabled).toBe(true);
    expect(a.filterHopsMin).toBe(1);
    expect(a.filterHopsMax).toBe(3);

    expect(b.enabled).toBe(false);
    expect(b.nodeNums).toEqual([333]);
    expect(b.filterChannels).toEqual([7]);
    expect(b.filterRoles.sort()).toEqual([2, 3]);
    expect(b.filterHwModels).toEqual([]);
    expect(b.filterNameRegex).toBe('bravo.*');
    expect(b.filterRolesEnabled).toBe(true);
    expect(b.filterRegexEnabled).toBe(false);
    expect(b.expirationHours).toBe(48);
    expect(b.sortByHops).toBe(false);
    expect(b.filterLastHeardEnabled).toBe(false);
    expect(b.filterLastHeardHours).toBe(168);
    expect(b.filterHopsEnabled).toBe(false);
    expect(b.filterHopsMin).toBe(5);
    expect(b.filterHopsMax).toBe(9);
  });

  it('returns defaults (no global fallback) when a source has no override', async () => {
    // Issue #2839 / #2840: each source must own its config independently.
    // A legacy global value must NOT leak into a per-source read; the
    // upgrade path is handled by migration 050, not by silent fallback.
    await dbService.setTracerouteFilterSettingsAsync({
      enabled: true,
      nodeNums: [],
      filterChannels: [4],
      filterRoles: [5],
      filterHwModels: [6],
      filterNameRegex: 'global-regex',
      filterNodesEnabled: true,
      filterChannelsEnabled: true,
      filterRolesEnabled: true,
      filterHwModelsEnabled: true,
      filterRegexEnabled: true,
      expirationHours: 36,
      sortByHops: true,
      filterLastHeardEnabled: true,
      filterLastHeardHours: 72,
      filterHopsEnabled: true,
      filterHopsMin: 2,
      filterHopsMax: 8,
    });

    const scoped = await dbService.getTracerouteFilterSettingsAsync(SOURCE_A);
    expect(scoped.filterChannels).toEqual([]);
    expect(scoped.filterNameRegex).toBe('.*');
    expect(scoped.expirationHours).toBe(24);
    expect(scoped.filterLastHeardHours).toBe(168);
    expect(scoped.filterHopsMin).toBe(0);
    expect(scoped.filterHopsMax).toBe(10);
  });

  it('changing source A does not leak into source B', async () => {
    const base = {
      enabled: true,
      nodeNums: [],
      filterChannels: [1],
      filterRoles: [],
      filterHwModels: [],
      filterNameRegex: '.*',
      filterNodesEnabled: true,
      filterChannelsEnabled: true,
      filterRolesEnabled: true,
      filterHwModelsEnabled: true,
      filterRegexEnabled: true,
      expirationHours: 24,
      sortByHops: false,
      filterLastHeardEnabled: false,
      filterLastHeardHours: 168,
      filterHopsEnabled: false,
      filterHopsMin: 0,
      filterHopsMax: 10,
    };
    await dbService.setTracerouteFilterSettingsAsync(base, SOURCE_A);
    await dbService.setTracerouteFilterSettingsAsync(base, SOURCE_B);

    // Mutate only source A.
    await dbService.setTracerouteFilterSettingsAsync(
      { ...base, filterChannels: [9], filterHopsEnabled: true, filterHopsMin: 4, filterHopsMax: 6 },
      SOURCE_A,
    );

    const a = await dbService.getTracerouteFilterSettingsAsync(SOURCE_A);
    const b = await dbService.getTracerouteFilterSettingsAsync(SOURCE_B);

    expect(a.filterChannels).toEqual([9]);
    expect(a.filterHopsEnabled).toBe(true);
    expect(a.filterHopsMin).toBe(4);
    expect(a.filterHopsMax).toBe(6);

    expect(b.filterChannels).toEqual([1]);
    expect(b.filterHopsEnabled).toBe(false);
    expect(b.filterHopsMin).toBe(0);
    expect(b.filterHopsMax).toBe(10);
  });
});
