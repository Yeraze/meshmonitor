#!/usr/bin/env node
/**
 * Fail CI when a built JS asset creeps toward (or past) the PWA precache cap,
 * or when the entry chunk regresses back toward its pre-#5530 size.
 *
 * Why this exists (#5526)
 * ------------------------
 * `vite-plugin-pwa`'s `injectManifest` hard-fails the Vite build (and so the
 * Docker build) the moment any precached asset exceeds
 * `maximumFileSizeToCacheInBytes` in vite.config.ts. #5520 tipped the old
 * single `main-*.js` chunk 1 KB over the then-4-MiB cap; #5530 fixed the root
 * cause by lazy-loading every route page (main-*.js: 4.2 MB -> ~171 KB) and
 * restored the cap to 4 MiB. Nothing stops the same creep from happening
 * again, one route or one heavy dependency at a time, except someone noticing
 * a failed Docker build after the fact. This script runs in CI right after
 * `npm run build` so the regression shows up as a readable CI failure instead.
 *
 * What it checks
 * ---------------
 * 1. Every `dist/assets/*.js` file stays under `SINGLE_ASSET_SAFETY_RATIO` of
 *    the PWA precache cap. Catches any chunk heading toward the hard build
 *    failure, with headroom to fix it before the cap is actually breached.
 * 2. The entry chunk (`main-*.js`, the one `index.html` loads eagerly) stays
 *    under `MAIN_CHUNK_BUDGET_BYTES`. Catches creep back into "everything is
 *    in the main chunk again" even though no single chunk is near the PWA cap
 *    (lazy route chunks can each be large without tripping check 1).
 *
 * `PWA_PRECACHE_CAP_BYTES` mirrors `maximumFileSizeToCacheInBytes` in
 * vite.config.ts (VitePWA -> injectManifest). vite.config.ts is TypeScript, so
 * parsing its arithmetic expression at CI time is more fragile than it's
 * worth — if you change the cap there, update the constant below in the same
 * commit (and vice versa).
 *
 * Raise a budget intentionally
 * -----------------------------
 * - Single-asset cap: only follows from `PWA_PRECACHE_CAP_BYTES` /
 *   `SINGLE_ASSET_SAFETY_RATIO`. Raise the PWA cap in vite.config.ts first
 *   (with its own justification), then update the mirrored constant here.
 * - Main chunk budget: bump `MAIN_CHUNK_BUDGET_BYTES` below, and update the
 *   comment with the new measured size and date (`npx vite build`, then
 *   `stat -c '%s' dist/assets/main-*.js`). Don't raise it to paper over an
 *   unreviewed regression — if the main chunk grew, check whether something
 *   that should be a lazy route/vendor chunk leaked back into it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Mirrors vite.config.ts VitePWA({ injectManifest: { maximumFileSizeToCacheInBytes } }).
// Keep these in sync — see "Raise a budget intentionally" above.
export const PWA_PRECACHE_CAP_BYTES = 4 * 1024 * 1024; // 4 MiB

// Fail an individual asset before it gets close enough to the PWA cap that a
// routine PR could tip it over and break the build outright.
export const SINGLE_ASSET_SAFETY_RATIO = 0.9;

// Entry chunk (`main-*.js`) budget. Measured 171,337 bytes (171.33 kB) for
// `main-B1LX_OjV.js` via `npx vite build` on 2026-10-02, right after #5530
// split every route page into a lazy chunk. ~2.1x that measured size —
// comfortably above today's size, but still well inside the single-asset cap
// above, and tight enough to flag the entry chunk silently regrowing.
export const MAIN_CHUNK_BUDGET_BYTES = 350 * 1024; // 350 KiB

const MAIN_CHUNK_PATTERN = /^main-.*\.js$/;
const JS_ASSET_PATTERN = /\.js$/;

/**
 * Pure threshold logic, kept separate from filesystem/gzip IO so it's cheap
 * to unit test. `assets` is a list of { name, size } for every JS asset in
 * the build output (name is the bare filename, e.g. `main-B1LX_OjV.js`).
 *
 * Returns `{ ok, errors }`. `errors` is a list of human-readable strings; an
 * empty list means the budgets passed. Never throws — callers decide what to
 * do with a failure (CI exits non-zero; tests just assert on the message).
 */
export function evaluateBundleBudgets(
  assets,
  {
    capBytes = PWA_PRECACHE_CAP_BYTES,
    singleAssetSafetyRatio = SINGLE_ASSET_SAFETY_RATIO,
    mainChunkBudgetBytes = MAIN_CHUNK_BUDGET_BYTES,
    mainChunkPattern = MAIN_CHUNK_PATTERN,
  } = {},
) {
  const errors = [];
  const singleAssetCapBytes = Math.floor(capBytes * singleAssetSafetyRatio);

  for (const asset of assets) {
    if (asset.size > singleAssetCapBytes) {
      errors.push(
        `${asset.name} is ${formatBytes(asset.size)}, over ${Math.round(singleAssetSafetyRatio * 100)}% ` +
          `of the PWA precache cap (${formatBytes(capBytes)}). Split this chunk further — exceeding the ` +
          `cap outright fails the Vite/Docker build (vite-plugin-pwa injectManifest).`,
      );
    }
  }

  const mainAssets = assets.filter((a) => mainChunkPattern.test(a.name));
  if (mainAssets.length === 0) {
    errors.push(
      `No entry chunk matching ${mainChunkPattern} was found in the build output — ` +
        `the main-chunk budget could not be checked. Did the Vite entry/output naming change?`,
    );
  }
  for (const asset of mainAssets) {
    if (asset.size > mainChunkBudgetBytes) {
      errors.push(
        `${asset.name} is ${formatBytes(asset.size)}, over the entry-chunk budget of ` +
          `${formatBytes(mainChunkBudgetBytes)}. See scripts/check-bundle-size.mjs for how to raise this ` +
          `budget intentionally, or split whatever grew the entry chunk into a lazy route/vendor chunk instead.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Reads every `*.js` file directly inside `assetsDir` with its size + gzip size. */
export function readJsAssets(assetsDir) {
  return readdirSync(assetsDir)
    .filter((name) => JS_ASSET_PATTERN.test(name))
    .map((name) => {
      const fullPath = path.join(assetsDir, name);
      // Read once and size the buffer, so size and gzip size describe the
      // same bytes (no stat-then-read race).
      const contents = readFileSync(fullPath);
      const size = contents.length;
      const gzipSize = gzipSync(contents).length;
      return { name, size, gzipSize };
    });
}

function printTable(assets) {
  const top = [...assets].sort((a, b) => b.size - a.size).slice(0, 10);
  const nameWidth = Math.max(4, ...top.map((a) => a.name.length));
  console.log(`\nLargest JS assets (${assets.length} total):`);
  console.log(`  ${'name'.padEnd(nameWidth)}  ${'raw'.padStart(10)}  ${'gzip'.padStart(10)}`);
  for (const asset of top) {
    console.log(
      `  ${asset.name.padEnd(nameWidth)}  ${formatBytes(asset.size).padStart(10)}  ${formatBytes(asset.gzipSize).padStart(10)}`,
    );
  }
  console.log('');
}

function main() {
  const assetsDirArg = process.argv[2];
  const assetsDir = assetsDirArg
    ? path.resolve(process.cwd(), assetsDirArg)
    : path.join(REPO_ROOT, 'dist', 'assets');

  let assets;
  try {
    assets = readJsAssets(assetsDir);
  } catch (err) {
    console.error(`check-bundle-size: could not read ${assetsDir}`);
    console.error(err.message);
    console.error('Run `npm run build` (or `npx vite build`) first.');
    process.exit(2);
    return;
  }

  if (assets.length === 0) {
    console.error(`check-bundle-size: no .js assets found in ${assetsDir}`);
    process.exit(2);
    return;
  }

  printTable(assets);

  const { ok, errors } = evaluateBundleBudgets(assets);
  if (ok) {
    console.log('OK — all JS assets are within the configured size budgets.');
    return;
  }

  console.error(`FAIL — ${errors.length} bundle-size budget violation(s):\n`);
  for (const message of errors) {
    console.error(`  - ${message}`);
  }
  console.error('');
  process.exit(1);
}

// Only run as a CLI entry point — importing this module for its exports (e.g.
// from the test file) must not trigger a filesystem scan.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
