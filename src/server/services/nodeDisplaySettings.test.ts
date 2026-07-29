/**
 * Node Display accessor service tests (#4412 Phase 2 WP1).
 *
 * Exercises the typed accessors against a stub reader (never a real DB —
 * that's covered by src/db/repositories/settings.test.ts for the batched
 * repo method). Pins the contract every WP2/WP3/WP4 call site depends on:
 * per-source value wins, a missing per-source row resolves to the hardcoded
 * default (never the global row), sourceId=null reads the bare key, and the
 * batched helper issues exactly one query and fills a default for every
 * requested id.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getNodeDisplayNumber,
  getNodeDisplayBoolean,
  getMaxNodeAgeHours,
  getMaxNodeAgeHoursForSources,
  getInactiveNodeConfig,
  getLocalStatsIntervalMinutes,
  type NodeDisplaySettingsReader,
  type NodeDisplayBatchReader,
} from './nodeDisplaySettings.js';
import { NODE_DISPLAY_NUMERIC_DEFAULTS } from '../../constants/nodeDisplayDefaults.js';

/** A stub reader backed by a plain Map, keyed exactly like the real repo's namespacing. */
function makeStubReader(store: Map<string, string>): NodeDisplaySettingsReader {
  return {
    getSettingForSource: vi.fn(async (sourceId: string | null | undefined, key: string) => {
      const storeKey = sourceId ? `source:${sourceId}:${key}` : key;
      return store.get(storeKey) ?? null;
    }),
  };
}

describe('getNodeDisplayNumber / getMaxNodeAgeHours', () => {
  it('per-source value wins when present', async () => {
    const store = new Map([['source:src-a:maxNodeAgeHours', '48']]);
    const reader = makeStubReader(store);
    expect(await getMaxNodeAgeHours(reader, 'src-a')).toBe(48);
  });

  it('missing per-source row returns the hardcoded default, never the global row', async () => {
    // Global row IS present, but source has no override — must NOT fall through to it.
    const store = new Map([['maxNodeAgeHours', '999']]);
    const reader = makeStubReader(store);
    expect(await getMaxNodeAgeHours(reader, 'src-a')).toBe(
      NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours,
    );
  });

  it('sourceId=null reads the bare (un-namespaced) key', async () => {
    const store = new Map([['maxNodeAgeHours', '72']]);
    const reader = makeStubReader(store);
    expect(await getMaxNodeAgeHours(reader, null)).toBe(72);
  });

  it('sourceId=undefined also reads the bare key', async () => {
    const store = new Map([['maxNodeAgeHours', '72']]);
    const reader = makeStubReader(store);
    expect(await getMaxNodeAgeHours(reader, undefined)).toBe(72);
  });

  it('generic getNodeDisplayNumber works for any numeric key', async () => {
    const store = new Map([['source:src-a:inactiveNodeCooldownHours', '5']]);
    const reader = makeStubReader(store);
    expect(await getNodeDisplayNumber(reader, 'src-a', 'inactiveNodeCooldownHours')).toBe(5);
  });
});

describe('getNodeDisplayBoolean', () => {
  it('per-source true/false round-trips', async () => {
    const store = new Map([
      ['source:src-a:hideIncompleteNodes', '1'],
      ['source:src-b:hideIncompleteNodes', '0'],
    ]);
    const reader = makeStubReader(store);
    expect(await getNodeDisplayBoolean(reader, 'src-a', 'hideIncompleteNodes')).toBe(true);
    expect(await getNodeDisplayBoolean(reader, 'src-b', 'hideIncompleteNodes')).toBe(false);
  });

  it('missing row resolves to the hardcoded default (false)', async () => {
    const reader = makeStubReader(new Map());
    expect(await getNodeDisplayBoolean(reader, 'src-a', 'nodeDimmingEnabled')).toBe(false);
  });
});

describe('getInactiveNodeConfig', () => {
  it('issues exactly three reads and clamps each independently', async () => {
    const store = new Map([
      ['source:src-a:inactiveNodeThresholdHours', '48'],
      ['source:src-a:inactiveNodeCheckIntervalMinutes', '9999'], // out of range (max 1440) -> default
      // cooldown not set at all -> default
    ]);
    const reader = makeStubReader(store);
    const spy = reader.getSettingForSource as ReturnType<typeof vi.fn>;

    const cfg = await getInactiveNodeConfig(reader, 'src-a');

    expect(spy).toHaveBeenCalledTimes(3);
    expect(cfg).toEqual({
      thresholdHours: 48,
      checkIntervalMinutes: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCheckIntervalMinutes,
      cooldownHours: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCooldownHours,
    });
  });

  it('all-defaults when nothing is stored for the source', async () => {
    const reader = makeStubReader(new Map());
    const cfg = await getInactiveNodeConfig(reader, 'src-a');
    expect(cfg).toEqual({
      thresholdHours: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeThresholdHours,
      checkIntervalMinutes: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCheckIntervalMinutes,
      cooldownHours: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCooldownHours,
    });
  });
});

describe('getLocalStatsIntervalMinutes', () => {
  it('reads the per-source value, including the meaningful 0 ("disabled")', async () => {
    const store = new Map([['source:src-a:localStatsIntervalMinutes', '0']]);
    const reader = makeStubReader(store);
    expect(await getLocalStatsIntervalMinutes(reader, 'src-a')).toBe(0);
  });

  it('falls through to the default (15) when unset', async () => {
    const reader = makeStubReader(new Map());
    expect(await getLocalStatsIntervalMinutes(reader, 'src-a')).toBe(15);
  });
});

describe('getMaxNodeAgeHoursForSources', () => {
  function makeBatchReader(rows: Map<string, string>): {
    reader: NodeDisplayBatchReader;
    getSettingForSources: ReturnType<typeof vi.fn>;
  } {
    const getSettingForSources = vi.fn(async (_sourceIds: string[], _key: string) => rows);
    return {
      reader: {
        getSettingForSource: vi.fn(async () => null),
        getSettingForSources,
      },
      getSettingForSources,
    };
  }

  it('returns an entry for every requested id, filling defaults for misses, in exactly one query', async () => {
    const { reader, getSettingForSources } = makeBatchReader(
      new Map([
        ['src-a', '1'],
        ['src-b', '168'],
        // src-c intentionally absent -> must be filled with the default
      ]),
    );

    const result = await getMaxNodeAgeHoursForSources(reader, ['src-a', 'src-b', 'src-c']);

    expect(getSettingForSources).toHaveBeenCalledTimes(1);
    expect(getSettingForSources).toHaveBeenCalledWith(['src-a', 'src-b', 'src-c'], 'maxNodeAgeHours');
    expect(result.get('src-a')).toBe(1);
    expect(result.get('src-b')).toBe(168);
    expect(result.get('src-c')).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
    expect(result.size).toBe(3);
  });

  it('empty input returns an empty Map and issues zero queries', async () => {
    const { reader, getSettingForSources } = makeBatchReader(new Map());
    const result = await getMaxNodeAgeHoursForSources(reader, []);
    expect(result.size).toBe(0);
    expect(getSettingForSources).not.toHaveBeenCalled();
  });

  it('clamps an out-of-range stored value to the default', async () => {
    const { reader } = makeBatchReader(new Map([['src-a', '-5']]));
    const result = await getMaxNodeAgeHoursForSources(reader, ['src-a']);
    expect(result.get('src-a')).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
  });
});
