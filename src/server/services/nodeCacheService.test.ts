/**
 * NodeCacheService tests
 *
 * Covers the in-memory node cache extracted from DatabaseService (Phase 3.4,
 * #3962): composite-key accessors, source-scoped iteration, mobility patching,
 * repo warm-up, and the NodesRepository cache-hook contract (upsert / delete /
 * cross-source replace / by-nodeId replace / clear).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodeCacheService } from './nodeCacheService.js';
import { ALL_SOURCES } from '../../db/repositories/base.js';
import type { DbNode } from '../../services/database.js';

const makeNode = (nodeNum: number, sourceId: string, overrides: Partial<DbNode> = {}): DbNode =>
  ({
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    hwModel: 1,
    sourceId,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }) as DbNode;

describe('NodeCacheService', () => {
  let cache: NodeCacheService;

  beforeEach(() => {
    cache = new NodeCacheService();
  });

  describe('composite-key accessors', () => {
    it('keys entries by nodeNum + sourceId', () => {
      expect(cache.cacheKey(123, 'src-a')).toBe('123:src-a');
      cache.set(123, 'src-a', makeNode(123, 'src-a'));
      cache.set(123, 'src-b', makeNode(123, 'src-b'));

      expect(cache.size).toBe(2);
      expect(cache.get(123, 'src-a')?.sourceId).toBe('src-a');
      expect(cache.get(123, 'src-b')?.sourceId).toBe('src-b');
      expect(cache.has(123, 'src-c')).toBe(false);
    });

    it('delete removes only the addressed source row', () => {
      cache.set(123, 'src-a', makeNode(123, 'src-a'));
      cache.set(123, 'src-b', makeNode(123, 'src-b'));
      cache.delete(123, 'src-a');
      expect(cache.has(123, 'src-a')).toBe(false);
      expect(cache.has(123, 'src-b')).toBe(true);
    });
  });

  describe('iterate (source scoping)', () => {
    beforeEach(() => {
      cache.set(1, 'src-a', makeNode(1, 'src-a'));
      cache.set(2, 'src-a', makeNode(2, 'src-a'));
      cache.set(3, 'src-b', makeNode(3, 'src-b'));
    });

    it('filters by concrete sourceId', () => {
      const nodes = Array.from(cache.iterate('src-a'));
      expect(nodes.map(n => n.nodeNum).sort()).toEqual([1, 2]);
    });

    it('yields everything for ALL_SOURCES and undefined', () => {
      expect(Array.from(cache.iterate(ALL_SOURCES))).toHaveLength(3);
      expect(Array.from(cache.iterate())).toHaveLength(3);
    });
  });

  describe('fromRepoNode', () => {
    it('converts repo nulls to cache-shape undefined/defaults', () => {
      const converted = cache.fromRepoNode(
        {
          nodeNum: 7,
          nodeId: '!00000007',
          longName: null,
          shortName: null,
          hwModel: null,
          batteryLevel: null,
          sourceId: null,
          createdAt: 1,
          updatedAt: 2,
        },
        'src-a'
      );
      expect(converted.longName).toBe('');
      expect(converted.shortName).toBe('');
      expect(converted.hwModel).toBe(0);
      expect(converted.batteryLevel).toBeUndefined();
      expect(converted.sourceId).toBe('src-a'); // falls back to the hook's sourceId
    });
  });

  describe('patchMobility', () => {
    it('patches the mobile flag for cached rows matching the nodeId', () => {
      cache.set(1, 'src-a', makeNode(1, 'src-a', { mobile: 0 }));
      cache.patchMobility('!00000001', 1);
      expect(cache.get(1, 'src-a')?.mobile).toBe(1);
    });

    it('leaves non-matching rows untouched', () => {
      cache.set(2, 'src-a', makeNode(2, 'src-a', { mobile: 0 }));
      cache.patchMobility('!00000001', 1);
      expect(cache.get(2, 'src-a')?.mobile).toBe(0);
    });
  });

  describe('warmFromRepo', () => {
    it('replaces contents from the repo across all sources', async () => {
      cache.set(99, 'stale', makeNode(99, 'stale'));
      const nodesRepo = {
        getAllNodes: vi.fn().mockResolvedValue([
          { nodeNum: 1, nodeId: '!00000001', sourceId: 'src-a', createdAt: 1, updatedAt: 1 },
          { nodeNum: 2, nodeId: '!00000002', sourceId: null, createdAt: 1, updatedAt: 1 },
        ]),
      };

      await cache.warmFromRepo(nodesRepo as any);

      expect(nodesRepo.getAllNodes).toHaveBeenCalledWith(ALL_SOURCES);
      expect(cache.size).toBe(2);
      expect(cache.has(99, 'stale')).toBe(false);
      expect(cache.get(1, 'src-a')).toBeDefined();
      // null sourceId falls back to 'default'
      expect(cache.get(2, 'default')?.sourceId).toBe('default');
    });
  });

  describe('buildHook (NodesRepository cache-hook contract)', () => {
    it('setNode upserts and deletes', () => {
      const hook = cache.buildHook();

      hook.setNode(5, 'src-a', makeNode(5, 'src-a'));
      expect(cache.has(5, 'src-a')).toBe(true);

      hook.setNode(5, 'src-a', null);
      expect(cache.has(5, 'src-a')).toBe(false);
    });

    it('setNodeAcrossSources drops rows for sources missing from the fresh set', () => {
      const hook = cache.buildHook();
      cache.set(5, 'src-a', makeNode(5, 'src-a'));
      cache.set(5, 'src-b', makeNode(5, 'src-b'));
      cache.set(6, 'src-b', makeNode(6, 'src-b')); // unrelated nodeNum — untouched

      hook.setNodeAcrossSources(5, [makeNode(5, 'src-a', { longName: 'fresh' })]);

      expect(cache.get(5, 'src-a')?.longName).toBe('fresh');
      expect(cache.has(5, 'src-b')).toBe(false);
      expect(cache.has(6, 'src-b')).toBe(true);
    });

    it('setNodeByNodeId replaces all rows carrying the nodeId', () => {
      const hook = cache.buildHook();
      cache.set(5, 'src-a', makeNode(5, 'src-a'));
      cache.set(5, 'src-b', makeNode(5, 'src-b'));

      hook.setNodeByNodeId('!00000005', [makeNode(5, 'src-b', { longName: 'kept' })]);

      expect(cache.has(5, 'src-a')).toBe(false);
      expect(cache.get(5, 'src-b')?.longName).toBe('kept');
    });

    it('clear empties the cache', () => {
      const hook = cache.buildHook();
      cache.set(1, 'src-a', makeNode(1, 'src-a'));
      hook.clear();
      expect(cache.size).toBe(0);
    });
  });
});
