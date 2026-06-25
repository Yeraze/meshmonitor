import { describe, it, expect } from 'vitest';
import {
  foldUnifiedMessagePages,
  DEFAULT_ACCUMULATOR_CAP,
  type AccumulableMessage,
} from './unifiedMessageAccumulator';

type Msg = AccumulableMessage & { receptions?: number };
const msg = (key: string, createdAt: number, receptions = 1): Msg => ({
  dedupKey: key,
  createdAt,
  receptions,
});

describe('foldUnifiedMessagePages', () => {
  it('returns pages sorted ascending by createdAt', () => {
    const acc = new Map<string, Msg>();
    const out = foldUnifiedMessagePages(acc, [[msg('c', 300), msg('a', 100), msg('b', 200)]]);
    expect(out.map((m) => m.dedupKey)).toEqual(['a', 'b', 'c']);
  });

  it('dedups within and across pages by dedupKey', () => {
    const acc = new Map<string, Msg>();
    const out = foldUnifiedMessagePages(acc, [
      [msg('a', 100), msg('b', 200)],
      [msg('b', 200), msg('c', 300)],
    ]);
    expect(out.map((m) => m.dedupKey)).toEqual(['a', 'b', 'c']);
  });

  // The core #3719 regression: a message present in an earlier poll but ABSENT
  // from a later poll (it scrolled past the server's newest-N window) must NOT
  // disappear from the accumulated feed.
  it('retains a message that is gone from a later poll (window starvation)', () => {
    const acc = new Map<string, Msg>();

    // Poll 1: the message of interest ('old') is the newest the server returned.
    foldUnifiedMessagePages(acc, [[msg('old', 100), msg('x', 90)]]);

    // Poll 2: 'old' has been pushed past the window; the server returns only
    // newer traffic and no longer includes it.
    const out = foldUnifiedMessagePages(acc, [[msg('n1', 200), msg('n2', 210)]]);

    expect(out.map((m) => m.dedupKey)).toEqual(['x', 'old', 'n1', 'n2']);
    expect(out.find((m) => m.dedupKey === 'old')).toBeTruthy();
  });

  it('upserts: a later, more-complete copy of the same key wins', () => {
    const acc = new Map<string, Msg>();
    foldUnifiedMessagePages(acc, [[msg('a', 100, 1)]]);
    const out = foldUnifiedMessagePages(acc, [[msg('a', 100, 3)]]); // extra receptions
    expect(out).toHaveLength(1);
    expect(out[0].receptions).toBe(3);
  });

  it('undefined pages returns the existing accumulated set (poll with no data)', () => {
    const acc = new Map<string, Msg>();
    foldUnifiedMessagePages(acc, [[msg('a', 100)]]);
    const out = foldUnifiedMessagePages(acc, undefined);
    expect(out.map((m) => m.dedupKey)).toEqual(['a']);
  });

  it('caps the set to the newest `cap` entries, dropping the oldest', () => {
    const acc = new Map<string, Msg>();
    const page = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, i)); // createdAt 0..9
    const out = foldUnifiedMessagePages(acc, [page], 4);
    expect(out.map((m) => m.dedupKey)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(acc.size).toBe(4); // accumulator itself is trimmed, not just the snapshot
    expect(acc.has('m0')).toBe(false);
  });

  it('keeps a generous default cap', () => {
    expect(DEFAULT_ACCUMULATOR_CAP).toBeGreaterThanOrEqual(2000);
  });
});
