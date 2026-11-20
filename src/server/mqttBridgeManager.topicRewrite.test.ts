/**
 * Unit tests for the applyTopicRewrite helper used by the mqtt_bridge
 * topic-rewrite feature (issue #3166). End-to-end bridge tests live in
 * mqttBridgeManager.test.ts; this file focuses on the pure helper.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTopicRewrite,
  applyTopicRewrites,
  normalizeTopicRewrites,
  uplinkRewriteTopics,
} from './mqttBridgeManager';

describe('applyTopicRewrite', () => {
  it('returns the topic unchanged when no rule is provided', () => {
    expect(applyTopicRewrite('msh/US/TX/2/e/Foo', null)).toBe('msh/US/TX/2/e/Foo');
    expect(applyTopicRewrite('msh/US/TX/2/e/Foo', undefined)).toBe('msh/US/TX/2/e/Foo');
  });

  it('replaces a matching prefix', () => {
    const rule = { from: 'msh/US/TX', to: 'msh/US/LA' };
    expect(applyTopicRewrite('msh/US/TX/2/e/Foo', rule)).toBe('msh/US/LA/2/e/Foo');
  });

  it('handles an exact match (no trailing path)', () => {
    const rule = { from: 'msh/US/TX', to: 'msh/US/LA' };
    expect(applyTopicRewrite('msh/US/TX', rule)).toBe('msh/US/LA');
  });

  it('does not partially match (msh/US/TX must not match msh/US/TXSomething)', () => {
    const rule = { from: 'msh/US/TX', to: 'msh/US/LA' };
    expect(applyTopicRewrite('msh/US/TXSomething/foo', rule)).toBe(
      'msh/US/TXSomething/foo',
    );
  });

  it('returns unchanged when the topic does not match the prefix', () => {
    const rule = { from: 'msh/US/TX', to: 'msh/US/LA' };
    expect(applyTopicRewrite('msh/CA/QC/2/e/Foo', rule)).toBe('msh/CA/QC/2/e/Foo');
  });

  it('normalizes trailing slashes on from and to', () => {
    expect(
      applyTopicRewrite('msh/US/TX/2/e/Foo', { from: 'msh/US/TX/', to: 'msh/US/LA' }),
    ).toBe('msh/US/LA/2/e/Foo');
    expect(
      applyTopicRewrite('msh/US/TX/2/e/Foo', { from: 'msh/US/TX', to: 'msh/US/LA/' }),
    ).toBe('msh/US/LA/2/e/Foo');
    expect(
      applyTopicRewrite('msh/US/TX/2/e/Foo', { from: 'msh/US/TX/', to: 'msh/US/LA/' }),
    ).toBe('msh/US/LA/2/e/Foo');
    expect(
      applyTopicRewrite('msh/US/TX/2/e/Foo', { from: 'msh/US/TX///', to: 'msh/US/LA' }),
    ).toBe('msh/US/LA/2/e/Foo');
  });

  it('returns unchanged when from is empty', () => {
    expect(applyTopicRewrite('msh/US/TX/foo', { from: '', to: 'msh/US/LA' })).toBe(
      'msh/US/TX/foo',
    );
    expect(applyTopicRewrite('msh/US/TX/foo', { from: '///', to: 'msh/US/LA' })).toBe(
      'msh/US/TX/foo',
    );
  });

  it('returns unchanged when to is empty', () => {
    expect(applyTopicRewrite('msh/US/TX/foo', { from: 'msh/US/TX', to: '' })).toBe(
      'msh/US/TX/foo',
    );
  });

  it('returns unchanged when from equals to (after trim)', () => {
    expect(
      applyTopicRewrite('msh/US/TX/foo', { from: 'msh/US/TX', to: 'msh/US/TX' }),
    ).toBe('msh/US/TX/foo');
    expect(
      applyTopicRewrite('msh/US/TX/foo', { from: 'msh/US/TX/', to: 'msh/US/TX' }),
    ).toBe('msh/US/TX/foo');
  });

  it('preserves the full tail after the prefix replacement', () => {
    const rule = { from: 'msh', to: 'sandbox' };
    expect(applyTopicRewrite('msh/US/TX/2/e/Foo', rule)).toBe('sandbox/US/TX/2/e/Foo');
  });

  it('handles a single-segment rewrite', () => {
    const rule = { from: 'a', to: 'b' };
    expect(applyTopicRewrite('a/foo', rule)).toBe('b/foo');
    expect(applyTopicRewrite('a', rule)).toBe('b');
    expect(applyTopicRewrite('ab/foo', rule)).toBe('ab/foo'); // not a/foo
  });

  it('is symmetric (uplink and downlink directions are independent rule calls)', () => {
    const downlink = { from: 'msh/US/TX', to: 'msh/US/LA' };
    const uplink = { from: 'msh/US/LA', to: 'msh/US/TX' };
    const original = 'msh/US/LA/2/e/Foo';
    const rewritten = applyTopicRewrite(original, uplink);
    expect(rewritten).toBe('msh/US/TX/2/e/Foo');
    // Reversing rewritten through the downlink rule should land back on the original.
    expect(applyTopicRewrite(rewritten, downlink)).toBe(original);
  });

  // Regression for CodeQL js/polynomial-redos (alerts #141, #142). The old
  // implementation used `.replace(/\/+$/, '')` which CodeQL flags as polynomial
  // backtrackable on adversarial all-slash input. The linear-time helper must
  // handle a megabyte of trailing slashes in milliseconds, not seconds.
  it('strips an adversarial run of trailing slashes in linear time', () => {
    const giantTail = '/'.repeat(1_000_000);
    const rule = { from: 'msh/US/TX' + giantTail, to: 'msh/US/LA' + giantTail };
    const start = Date.now();
    const out = applyTopicRewrite('msh/US/TX/2/e/Foo', rule);
    const elapsed = Date.now() - start;
    expect(out).toBe('msh/US/LA/2/e/Foo');
    // 1M-char strip should be well under a second even on a slow CI box.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('normalizeTopicRewrites (#6516)', () => {
  it('reads a legacy object, a list, or nothing', () => {
    const rule = { from: 'a', to: 'b' };
    expect(normalizeTopicRewrites(rule)).toEqual([rule]);
    expect(normalizeTopicRewrites([rule, rule])).toEqual([rule, rule]);
    expect(normalizeTopicRewrites(undefined)).toEqual([]);
    expect(normalizeTopicRewrites([])).toEqual([]);
  });

  it('drops malformed entries instead of throwing', () => {
    expect(normalizeTopicRewrites('msh/US')).toEqual([]);
    expect(normalizeTopicRewrites([null, 'x', { from: 1, to: 'b' }, { from: 'a', to: 'b' }])).toEqual([
      { from: 'a', to: 'b' },
    ]);
  });
});

describe('applyTopicRewrites — downlink (#6516)', () => {
  const merge = [
    { from: 'root/branch_1', to: 'local_branch' },
    { from: 'root/branch_2', to: 'local_branch' },
  ];

  it('merges several upstream branches into one local prefix', () => {
    expect(applyTopicRewrites('root/branch_1/2/e/LongFast/!a', merge)).toBe('local_branch/2/e/LongFast/!a');
    expect(applyTopicRewrites('root/branch_2/2/e/LongFast/!a', merge)).toBe('local_branch/2/e/LongFast/!a');
    expect(applyTopicRewrites('root/branch_3/2/e/LongFast/!a', merge)).toBe('root/branch_3/2/e/LongFast/!a');
  });

  it('uses the longest matching prefix, whatever the list order', () => {
    const rules = [
      { from: 'root', to: 'all' },
      { from: 'root/branch_1', to: 'one' },
    ];
    expect(applyTopicRewrites('root/branch_1/x', rules)).toBe('one/x');
    expect(applyTopicRewrites('root/branch_2/x', rules)).toBe('all/branch_2/x');
  });

  it('applies one rule only: rules never chain', () => {
    const rules = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(applyTopicRewrites('a/x', rules)).toBe('b/x');
  });

  it('still takes the legacy single object', () => {
    expect(applyTopicRewrites('msh/US/x', { from: 'msh/US', to: 'msh/local' })).toBe('msh/local/x');
  });
});

describe('uplinkRewriteTopics (#6516)', () => {
  const branches = [
    { from: 'local_branch', to: 'root/branch_1' },
    { from: 'local_branch', to: 'root/branch_2' },
  ];

  it('without fan-out, goes to the first matching rule only (the primary)', () => {
    expect(uplinkRewriteTopics('local_branch/2/e/x', branches, false)).toEqual(['root/branch_1/2/e/x']);
  });

  it('with fan-out, goes to every matching rule', () => {
    expect(uplinkRewriteTopics('local_branch/2/e/x', branches, true)).toEqual([
      'root/branch_1/2/e/x',
      'root/branch_2/2/e/x',
    ]);
  });

  it('primary is list order, not the longest prefix', () => {
    const rules = [
      { from: 'local', to: 'a' },
      { from: 'local/sub', to: 'b' },
    ];
    expect(uplinkRewriteTopics('local/sub/x', rules, false)).toEqual(['a/sub/x']);
  });

  it('keeps the topic when nothing matches, and dedupes identical targets', () => {
    expect(uplinkRewriteTopics('other/x', branches, true)).toEqual(['other/x']);
    expect(uplinkRewriteTopics('x/y', [{ from: 'x', to: 'z' }, { from: 'x/', to: 'z' }], true)).toEqual(['z/y']);
    expect(uplinkRewriteTopics('x/y', undefined, true)).toEqual(['x/y']);
  });
});
