import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Test files that talk to the SHARED PostgreSQL / MySQL test databases
 * (`meshmonitor_test` on :5433 / :3307, via `src/db/repositories/test-utils.ts`).
 *
 * These cannot run concurrently with each other. Each one issues
 * `DROP TABLE IF EXISTS <t> CASCADE` + `CREATE TABLE <t>` against a single shared
 * database at import time, so two of them in flight at once will drop a table out
 * from under the other's queries. The overlaps are real, not theoretical:
 *   `users` — auth, channelDatabase, notifications
 *   `nodes` — nodes, keyRepair.multidb, notifications
 *
 * They therefore run in their own serial project (see `projects` below). Locally
 * these skip entirely unless the containers are up (`npm run test:db:up`), so the
 * serial cost is a CI-only ~1 min; in CI both containers are service containers.
 *
 * Add a file here whenever it starts using `createPostgresBackend` /
 * `createMysqlBackend`. If it only ever uses `createSqliteBackend`, leave it out —
 * SQLite backends are per-process `:memory:` and are safe to parallelize.
 */
const SHARED_DB_TESTS = [
  'src/db/repositories/atakContacts.test.ts',
  'src/db/repositories/auth.test.ts',
  'src/db/repositories/autoTraceroute.test.ts',
  'src/db/repositories/backupHistory.test.ts',
  'src/db/repositories/channelDatabase.test.ts',
  'src/db/repositories/channels.test.ts',
  'src/db/repositories/ignoredNodes.test.ts',
  'src/db/repositories/keyRepair.multidb.test.ts',
  'src/db/repositories/neighbors.test.ts',
  'src/db/repositories/newsCache.test.ts',
  'src/db/repositories/nodes.test.ts',
  'src/db/repositories/notifications.test.ts',
  'src/db/repositories/settings.test.ts',
  'src/db/repositories/solarEstimates.test.ts',
  'src/db/repositories/traceroutes.test.ts',
  // Migration 132's container half (#4416 WP2) drops/recreates `users`,
  // `permissions`, AND `sources` against the shared PG/MySQL test DB —
  // overlapping auth.test.ts (`users`, `permissions`) and channels.test.ts
  // (`sources`). Confirmed empirically: running it concurrently with
  // auth.test.ts's DROP TABLE ordering intermittently raises
  // ER_FK_CANNOT_DROP_PARENT on MySQL.
  'src/server/migrations/132_fan_out_settings_permissions.pgmysql.test.ts',
  // Reticulum epic #3960, Phase 1a WP1: `reticulum.test.ts` and migrations
  // 140/141's container halves all DROP/CREATE `reticulum_destinations` /
  // `reticulum_interfaces` against the shared PG/MySQL test DB — confirmed
  // empirically (intermittent "table doesn't exist" mid-test on MySQL when
  // run concurrently with the migration pgmysql tests).
  'src/server/migrations/140_create_reticulum_destinations.pgmysql.test.ts',
  'src/server/migrations/141_create_reticulum_interfaces.pgmysql.test.ts',
  'src/db/repositories/reticulum.test.ts',
  // reticulumTelemetry.test.ts's regression guard DROPs/CREATEs the shared
  // `telemetry` table against the same PG/MySQL test DB as
  // telemetry.multidb.test.ts — both must join the serial group together.
  'src/server/services/reticulumTelemetry.test.ts',
  'src/db/repositories/telemetry.multidb.test.ts',
];

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
          exclude: [...COMMON_EXCLUDE, ...SHARED_DB_TESTS],
        },
      },
      {
        extends: true,
        test: {
          ...COMMON_TEST,
          name: 'shared-db',
          include: SHARED_DB_TESTS,
          exclude: COMMON_EXCLUDE,
          // Serial: these share one PostgreSQL/MySQL database. See SHARED_DB_TESTS.
          fileParallelism: false,
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
