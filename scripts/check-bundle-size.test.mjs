/**
 * Unit tests for the pure threshold logic in check-bundle-size.mjs.
 * evaluateBundleBudgets() touches no filesystem; evaluateEagerThemeCss() runs
 * against small fixture dist directories in the OS temp dir.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  evaluateBundleBudgets,
  evaluateEagerThemeCss,
  extractStylesheetHrefs,
  formatBytes,
  hasThemeRule,
} from './check-bundle-size.mjs';

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

describe('eager theme CSS check (#5558)', () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Builds a fixture dist: index.html linking `sheets`, plus extra asset files. */
  function makeDist({ sheets = {}, extra = {}, html } = {}) {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'mm-bundle-check-'));
    made.push(dist);
    mkdirSync(path.join(dist, 'assets'));
    for (const [name, css] of Object.entries({ ...sheets, ...extra })) {
      writeFileSync(path.join(dist, 'assets', name), css);
    }
    const links = Object.keys(sheets)
      .map((name) => `<link rel="stylesheet" crossorigin href="/assets/${name}">`)
      .join('\n');
    writeFileSync(
      path.join(dist, 'index.html'),
      html ?? `<!doctype html><html><head>\n<script type="module" src="/assets/main-a.js"></script>\n${links}\n</head><body></body></html>`,
    );
    return dist;
  }

  // Vite's minifier drops the quotes; the source keeps them.
  const THEMES_MINIFIED = ':root[data-theme=latte]{--ctp-base:#eff1f5}:root[data-theme=mocha]{--ctp-base:#1e1e2e}';
  const THEMES_SOURCE = ":root[data-theme='latte'] { --ctp-base: #eff1f5; }\n:root[data-theme=\"mocha\"] { --ctp-base: #1e1e2e; }";

  it('passes when the linked entry sheet holds the theme rules (macOS/Linux shape)', () => {
    const dist = makeDist({ sheets: { 'main-abc.css': `body{margin:0}${THEMES_MINIFIED}` } });
    const result = evaluateEagerThemeCss(dist);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stylesheets).toHaveLength(1);
    expect(result.stylesheets[0].href).toBe('/assets/main-abc.css');
  });

  it('accepts quoted selectors too', () => {
    const dist = makeDist({ sheets: { 'main-abc.css': THEMES_SOURCE } });
    expect(evaluateEagerThemeCss(dist).ok).toBe(true);
  });

  it('fails when the theme rules sit only in an unlinked lazy chunk (the Windows build of #5558)', () => {
    const dist = makeDist({
      sheets: { 'main-abc.css': 'body{margin:0}' },
      extra: { 'App-def.css': THEMES_MINIFIED },
    });
    const result = evaluateEagerThemeCss(dist);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('mocha, latte');
    expect(result.errors[0]).toContain('#5558');
  });

  it('names only the theme that is missing', () => {
    const dist = makeDist({ sheets: { 'main-abc.css': ':root[data-theme=mocha]{color:red}' } });
    const result = evaluateEagerThemeCss(dist);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('for: latte ');
  });

  it('fails when index.html links no stylesheet', () => {
    const dist = makeDist({ extra: { 'App-def.css': THEMES_MINIFIED } });
    const result = evaluateEagerThemeCss(dist);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('links no stylesheet');
  });

  it('fails when a linked stylesheet is missing from dist', () => {
    const dist = makeDist({
      html: '<html><head><link rel="stylesheet" href="/assets/gone.css"></head></html>',
    });
    const result = evaluateEagerThemeCss(dist);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('gone.css');
  });

  it('fails when dist has no index.html', () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), 'mm-bundle-check-'));
    made.push(dist);
    const result = evaluateEagerThemeCss(dist);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('index.html');
  });

  it('extractStylesheetHrefs() reads only stylesheet links, in any attribute order', () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="modulepreload" href="/assets/x.js">
      <link href='/assets/a.css' rel='stylesheet'>
      <link rel="stylesheet" crossorigin href="/assets/b.css">
      <link rel="stylesheet" href="https://fonts.example/css?x=1">`;
    expect(extractStylesheetHrefs(html)).toEqual([
      '/assets/a.css',
      '/assets/b.css',
      'https://fonts.example/css?x=1',
    ]);
  });

  it('skips stylesheets on another origin', () => {
    const dist = makeDist({
      html: '<html><head><link rel="stylesheet" href="https://fonts.example/css"><link rel="stylesheet" href="./assets/main-abc.css"></head></html>',
      extra: { 'main-abc.css': THEMES_MINIFIED },
    });
    const result = evaluateEagerThemeCss(dist);
    expect(result.errors).toEqual([]);
    expect(result.stylesheets.map((s) => s.href)).toEqual(['./assets/main-abc.css']);
  });

  it('hasThemeRule() does not match a longer theme name', () => {
    expect(hasThemeRule(':root[data-theme=mocha-dim]{}', 'mocha')).toBe(false);
    expect(hasThemeRule(':root[data-theme=mocha]{}', 'mocha')).toBe(true);
  });
});
