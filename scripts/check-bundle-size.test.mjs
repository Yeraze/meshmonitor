/**
 * Unit tests for the pure threshold logic in check-bundle-size.mjs.
 * No filesystem/build output involved — only evaluateBundleBudgets().
 */
import { describe, it, expect } from 'vitest';
import { evaluateBundleBudgets, formatBytes } from './check-bundle-size.mjs';

const CAP = 4 * 1024 * 1024; // 4 MiB, mirrors the real PWA cap in these tests
const RATIO = 0.9;
const MAIN_BUDGET = 350 * 1024;

describe('evaluateBundleBudgets()', () => {
  it('passes when every asset is comfortably under both budgets', () => {
    const assets = [
      { name: 'main-abc123.js', size: 171_337 },
      { name: 'App-def456.js', size: 1_393_089 },
      { name: 'lib-ghi789.js', size: 115_160 },
    ];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: MAIN_BUDGET,
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails a single asset that exceeds the safety-margin cap', () => {
    const overCap = Math.floor(CAP * RATIO) + 1;
    const assets = [
      { name: 'main-abc123.js', size: 1024 },
      { name: 'Huge-xyz999.js', size: overCap },
    ];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: MAIN_BUDGET,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Huge-xyz999.js');
    expect(result.errors[0]).toContain('PWA precache cap');
  });

  it('does not fail an asset exactly at the safety-margin boundary', () => {
    const atBoundary = Math.floor(CAP * RATIO);
    const assets = [{ name: 'main-abc123.js', size: atBoundary }];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: CAP, // keep the main-chunk check out of play here
    });
    expect(result.ok).toBe(true);
  });

  it('fails when main-*.js exceeds the entry-chunk budget', () => {
    const assets = [{ name: 'main-abc123.js', size: MAIN_BUDGET + 1 }];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: MAIN_BUDGET,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('main-abc123.js');
    expect(result.errors[0]).toContain('entry-chunk budget');
  });

  it('fails when no asset matches the entry-chunk pattern', () => {
    const assets = [{ name: 'App-def456.js', size: 1024 }];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: MAIN_BUDGET,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('No entry chunk'))).toBe(true);
  });

  it('can report multiple violations at once', () => {
    const overCap = Math.floor(CAP * RATIO) + 1;
    const assets = [
      { name: 'main-abc123.js', size: MAIN_BUDGET + 1 },
      { name: 'Huge-xyz999.js', size: overCap },
    ];
    const result = evaluateBundleBudgets(assets, {
      capBytes: CAP,
      singleAssetSafetyRatio: RATIO,
      mainChunkBudgetBytes: MAIN_BUDGET,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe('formatBytes()', () => {
  it('formats bytes as KiB with one decimal place', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(171_337)).toBe('167.3 KiB');
  });
});
