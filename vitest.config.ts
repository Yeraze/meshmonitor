import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * PostgreSQL / MySQL container suites are ISOLATED, not serialized.
 *
 * Both test containers expose exactly one database (`meshmonitor_test`), and
 * Vitest runs test files in parallel forks. Historically every suite that
 * talked to :5433 / :3307 issued `DROP TABLE` + `CREATE TABLE` against that one
 * shared database, so any two suites sharing a table name dropped it out from
 * under each other mid-test. The workaround was a checked-in `SHARED_DB_TESTS`
 * list feeding a serial `shared-db` project — which papered over the fixture
 * bug at the cost of running those files one at a time on every CI leg, and
 * still missed several pairs (`mesh_issues`, `messages`, `settings`, `sources`, `telemetry`,
 * `traceroutes`, `auto_traceroute_nodes`) whose two halves sat in *different*
 * projects and therefore still ran concurrently.
 *
 * Every container suite now takes its own throwaway database
 * (`meshmonitor_test_<key>_<token>`) via `createIsolatedPostgresDatabase` /
 * `createIsolatedMysqlDatabase`, or by passing `isolationKey` to
 * `createPostgresBackend` / `createMysqlBackend`. See the "Per-suite fixture
 * isolation" banner in `src/db/repositories/test-utils.ts`.
 *
 * If you add a suite that talks to those containers, give it an isolation key.
 * Do NOT add it to a serial list and do NOT set `fileParallelism: false`.
 */

const COMMON_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.paperclip/**',
  'takpacket-sdk/**', // git submodule — has its own vitest suite (#4317)
  // Agent worktrees are git-excluded, so CI never sees them, but locally they are
  // real files on disk that Vitest happily collects — one leftover worktree
  // re-runs the ENTIRE suite an extra time (measured: +11 min, +22k phantom
  // tests, and phantom failures from the worktree's own stale deps). Same class
  // of gotcha as the lint ratchet's `.claude/worktrees` caveat in CLAUDE.md.
  '**/.claude/worktrees/**',
];

/** Settings shared by both projects. */
const COMMON_TEST = {
  globals: true,
  environment: 'node' as const, // tests override per-file with @vitest-environment
  setupFiles: './src/test/setup.ts',
  isolate: true,
  testTimeout: 10000,
  hookTimeout: 10000,
  pool: 'forks' as const,
  env: {
    DATABASE_PATH: ':memory:',
  },
};

export default defineConfig({
  plugins: [react()],
  test: {
    // Test files run in parallel across forks — Vitest's default.
    //
    // History (read before re-serializing): `fileParallelism: false` plus
    // `poolOptions.forks.singleFork` were added in #295 (2025-10-24) as a drive-by
    // in an unrelated feature PR, when this suite was 47 files, to dodge an OOM.
    // The suite is now ~790 files, and that one line was the single largest cost
    // in CI: the per-file import + transform cost (~1s each) was paid one file at
    // a time, so ~20 min of the run was startup, not testing. `poolOptions` had
    // also become dead weight — Vitest 4 removed it, so `singleFork` silently
    // stopped applying and only `fileParallelism: false` was still serializing.
    //
    // Memory is now bounded by `maxWorkers`, not by running one file at a time.
    // If OOM ever returns, lower `maxWorkers` — do not re-serialize the suite.
    maxWorkers: process.env.CI ? 4 : '75%',
    exclude: COMMON_EXCLUDE,
    projects: [
      {
        // `extends: true` inherits plugins + resolve.alias from this file.
        extends: true,
        test: {
          ...COMMON_TEST,
          name: 'unit',
          exclude: COMMON_EXCLUDE,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '*.config.ts',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.tsx'
      ],
      thresholds: {
        statements: 32,
        'src/utils/**': {
          statements: 70,
        },
        'src/server/**': {
          statements: 25,
        },
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The MapLibre worker URL is a build-only Vite `?worker&url` virtual
      // import (maplibreWorker.ts, #4800) that Vitest cannot resolve; stub it so
      // any test importing Base3DMap can collect. jsdom tests mock maplibre-gl.
      'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url': path.resolve(
        __dirname,
        'src/test/maplibreWorkerUrlStub.ts',
      ),
      // Force the ESM build of the spiderfier under Vitest. Its package `main`
      // is a UMD bundle whose named `OverlappingMarkerSpiderfier` export isn't a
      // constructor when Vitest externalizes it, so any test that mounts a
      // spiderfier-using map component (e.g. MeshCoreSourcePage → MeshCoreMap)
      // throws "OverlappingMarkerSpiderfier is not a constructor". The `module`
      // (ESM) entry exports the real class. App build (vite.config) is unaffected.
      'ts-overlapping-marker-spiderfier-leaflet': path.resolve(
        __dirname,
        'node_modules/ts-overlapping-marker-spiderfier-leaflet/dist/omsleaflet.js',
      ),
    }
  }
});
