import { describe, it, expect } from 'vitest';
import {
  encodeReceiverFilter,
  parseReceiverFilter,
  buildReceiverQuery,
  receiverKey,
  type CoverageReceiverFilterEntry,
} from './coverageReceiverFilter.js';

describe('coverageReceiverFilter', () => {
  describe('receiverKey', () => {
    it('namespaces a receiverId by sourceId', () => {
      expect(receiverKey('src-a', '!aaaaaaaa')).toBe('src-a|!aaaaaaaa');
      expect(receiverKey('src-b', '!aaaaaaaa')).toBe('src-b|!aaaaaaaa');
    });
  });

  describe('encode/parse round trip', () => {
    it('round-trips a single include entry', () => {
      const entries: CoverageReceiverFilterEntry[] = [
        { sourceId: 'src-a', mode: 'include', receiverIds: ['!aaaaaaaa', '!bbbbbbbb'] },
      ];
      const encoded = encodeReceiverFilter(entries);
      expect(encoded).toBe('src-a:+!aaaaaaaa,!bbbbbbbb');
      expect(parseReceiverFilter(encoded)).toEqual(entries);
    });

    it('round-trips a mix of include and exclude entries across sources', () => {
      const entries: CoverageReceiverFilterEntry[] = [
        { sourceId: 'src-a', mode: 'include', receiverIds: ['!aaaaaaaa'] },
        { sourceId: 'src-b', mode: 'exclude', receiverIds: ['!cccccccc', '!dddddddd'] },
      ];
      const encoded = encodeReceiverFilter(entries);
      expect(encoded).toBe('src-a:+!aaaaaaaa;src-b:-!cccccccc,!dddddddd');
      expect(parseReceiverFilter(encoded)).toEqual(entries);
    });

    it('drops entries with an empty receiverIds array when encoding', () => {
      const entries: CoverageReceiverFilterEntry[] = [
        { sourceId: 'src-a', mode: 'include', receiverIds: [] },
        { sourceId: 'src-b', mode: 'include', receiverIds: ['!aaaaaaaa'] },
      ];
      expect(encodeReceiverFilter(entries)).toBe('src-b:+!aaaaaaaa');
    });
  });

  describe('parseReceiverFilter rejections', () => {
    it('rejects undefined/non-string input', () => {
      expect(parseReceiverFilter(undefined)).toBeNull();
      expect(parseReceiverFilter(null)).toBeNull();
      expect(parseReceiverFilter(123)).toBeNull();
      expect(parseReceiverFilter(['src-a:+!aaaaaaaa'])).toBeNull();
    });

    it('rejects an empty or blank string', () => {
      expect(parseReceiverFilter('')).toBeNull();
      expect(parseReceiverFilter('   ')).toBeNull();
    });

    it('rejects a sourceId containing bad characters (colon/semicolon/comma)', () => {
      // A literal comma inside what would be the sourceId segment.
      expect(parseReceiverFilter('src,a:+!aaaaaaaa')).toBeNull();
      // No colon at all — can't tell source from grammar.
      expect(parseReceiverFilter('src-a+!aaaaaaaa')).toBeNull();
      // Missing sourceId before the colon.
      expect(parseReceiverFilter(':+!aaaaaaaa')).toBeNull();
    });

    it('rejects a bad receiver id', () => {
      expect(parseReceiverFilter('src-a:+!aa aaaaa')).toBeNull();
      expect(parseReceiverFilter('src-a:+bad$id')).toBeNull();
    });

    it('rejects more than 1000 ids in total', () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `!${i.toString(16).padStart(8, '0')}`).join(',');
      expect(parseReceiverFilter(`src-a:+${ids}`)).toBeNull();
    });

    it('accepts exactly 1000 ids in total', () => {
      const ids = Array.from({ length: 1000 }, (_, i) => `!${i.toString(16).padStart(8, '0')}`);
      const parsed = parseReceiverFilter(`src-a:+${ids.join(',')}`);
      expect(parsed).not.toBeNull();
      expect(parsed?.[0]?.receiverIds).toHaveLength(1000);
    });

    it('rejects empty grammar parts (stray semicolons)', () => {
      expect(parseReceiverFilter('src-a:+!aaaaaaaa;;src-b:+!bbbbbbbb')).toBeNull();
      expect(parseReceiverFilter(';src-a:+!aaaaaaaa')).toBeNull();
      expect(parseReceiverFilter('src-a:+!aaaaaaaa;')).toBeNull();
    });

    it('rejects a missing mode character', () => {
      expect(parseReceiverFilter('src-a:!aaaaaaaa')).toBeNull();
    });

    it('rejects an entry with no ids after the mode character', () => {
      expect(parseReceiverFilter('src-a:+')).toBeNull();
    });
  });

  describe('buildReceiverQuery', () => {
    const receivers = [
      { sourceId: 'src-a', receiverId: '!a1' },
      { sourceId: 'src-a', receiverId: '!a2' },
      { sourceId: 'src-a', receiverId: '!a3' },
      { sourceId: 'src-b', receiverId: '!b1' },
      { sourceId: 'src-b', receiverId: '!b2' },
    ];

    it('all selected → no filter and no sources', () => {
      const result = buildReceiverQuery(receivers, new Set());
      expect(result.receiverFilter).toBeUndefined();
      expect(result.sources).toBeUndefined();
      expect(result.noneSelected).toBe(false);
    });

    it('one source fully off → dropped from sources, no entry needed for it', () => {
      const deselected = new Set([receiverKey('src-b', '!b1'), receiverKey('src-b', '!b2')]);
      const result = buildReceiverQuery(receivers, deselected);
      expect(result.sources).toEqual(['src-a']);
      expect(result.receiverFilter).toBeUndefined();
      expect(result.noneSelected).toBe(false);
    });

    it('partial selection picks the shorter of include/exclude', () => {
      // src-a: 1 deselected of 3 → exclude is shorter (1 vs 2).
      const deselected = new Set([receiverKey('src-a', '!a1')]);
      const result = buildReceiverQuery(receivers, deselected);
      // Both sources keep at least one receiver → `sources` stays omitted.
      expect(result.sources).toBeUndefined();
      expect(result.receiverFilter).toEqual([
        { sourceId: 'src-a', mode: 'exclude', receiverIds: ['!a1'] },
      ]);
    });

    it('partial selection picks include when it is the shorter side', () => {
      // src-a: 2 deselected of 3 → include is shorter (1 vs 2).
      const deselected = new Set([receiverKey('src-a', '!a1'), receiverKey('src-a', '!a2')]);
      const result = buildReceiverQuery(receivers, deselected);
      expect(result.receiverFilter).toEqual([
        { sourceId: 'src-a', mode: 'include', receiverIds: ['!a3'] },
      ]);
    });

    it('the same receiverId on two sources toggles independently (carry-over a)', () => {
      const shared = [
        { sourceId: 'src-a', receiverId: '!shared' },
        { sourceId: 'src-b', receiverId: '!shared' },
      ];
      const deselected = new Set([receiverKey('src-a', '!shared')]);
      const result = buildReceiverQuery(shared, deselected);
      expect(result.sources).toEqual(['src-b']);
      expect(result.receiverFilter).toBeUndefined();
    });

    it('noneSelected is true once every receiver is deselected', () => {
      const deselected = new Set(receivers.map((r) => receiverKey(r.sourceId, r.receiverId)));
      const result = buildReceiverQuery(receivers, deselected);
      expect(result.noneSelected).toBe(true);
      expect(result.sources).toEqual([]);
    });

    it('an empty receiver list is never "noneSelected"', () => {
      const result = buildReceiverQuery([], new Set());
      expect(result.noneSelected).toBe(false);
    });

    it('falls back to clientSideFilter once the minimised id count exceeds 1000', () => {
      const many = Array.from({ length: 2200 }, (_, i) => ({
        sourceId: 'src-a',
        receiverId: `!${i.toString(16).padStart(8, '0')}`,
      }));
      // Deselect half — shorter side (1100) exceeds the 1000 cap either way.
      const deselected = new Set(many.slice(0, 1100).map((r) => receiverKey(r.sourceId, r.receiverId)));
      const result = buildReceiverQuery(many, deselected);
      expect(result.clientSideFilter).toBe(true);
      expect(result.receiverFilter).toBeUndefined();
    });
  });
});
