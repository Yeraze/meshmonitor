# Review: Database Architecture Remediation Plan

**Reviewed:** `docs/superpowers/plans/2026-03-16-database-architecture-remediation.md`
**Reviewer:** Senior Code Reviewer (Claude Opus 4.6)
**Date:** 2026-03-16

---

## Overall Assessment

The plan is well-structured, properly phased, and correctly identifies the core problems (N x 3 branching, BIGINT bugs, migration fragility, dual schema truth). The Active Schema Map approach is architecturally sound given Drizzle's constraint of separate dialect definitions. Phase sequencing and dependencies are correct.

However, there are several concrete errors and omissions that would block an engineer from executing this plan without investigation.

---

## Critical Issues (Must Fix Before Execution)

### C1: Wrong export names in activeSchema.ts -- notifications schema

The plan uses `notificationPreferencesSqlite/Postgres/Mysql` (lines 296-305 of the plan). The actual exports are `userNotificationPreferencesSqlite/Postgres/Mysql` (notifications.ts lines 39, 61, 113).

**Fix:** Replace all `notificationPreferences*` references in the SCHEMA_MAP with `userNotificationPreferences*`.

### C2: Wrong export name -- neighbors schema

The plan uses `neighborsSqlite/Postgres/Mysql` (lines 294, etc.). The actual exports are `neighborInfoSqlite/Postgres/Mysql` (neighbors.ts lines 11, 22, 33).

**Fix:** Replace the `neighbors:` key mapping to use `neighborInfoSqlite/Postgres/Mysql`.

### C3: Wrong export name -- packets schema

The plan uses `packetsSqlite/Postgres/Mysql` (line 306). The actual exports are `packetLogSqlite/Postgres/Mysql` (packets.ts lines 11, 44, 77).

**Fix:** Replace the `packets:` key mapping to use `packetLogSqlite/Postgres/Mysql`.

### C4: Missing tables in ActiveSchema

The `activeSchema.ts` SCHEMA_MAP is incomplete. The following tables have Drizzle schemas but are absent from the plan's map:

| Missing Table | Schema File | Export Pattern |
|---|---|---|
| `sessions` | auth.ts | `sessionsSqlite/Postgres/Mysql` |
| `systemBackupHistory` | misc.ts | `systemBackupHistorySqlite/Postgres/Mysql` |
| `userMapPreferences` | misc.ts | `userMapPreferencesSqlite/Postgres/Mysql` |
| `solarEstimates` | misc.ts | `solarEstimatesSqlite/Postgres/Mysql` |
| `autoTracerouteNodes` | misc.ts | `autoTracerouteNodesSqlite/Postgres/Mysql` |
| `autoTimeSyncNodes` | misc.ts | `autoTimeSyncNodesSqlite/Postgres/Mysql` |
| `newsCache` | misc.ts | `newsCacheSqlite/Postgres/Mysql` |
| `userNewsStatus` | misc.ts | `userNewsStatusSqlite/Postgres/Mysql` |

The plan only lists 26 tables, but there are at least 34 Drizzle-defined table groups. The test in Step 1 (Task 1.1) lists `expectedTables` that would pass with an incomplete map if the test only checks those specific keys.

**Fix:** Add all missing table groups to the SCHEMA_MAP and the test's `expectedTables` array.

### C5: `estimatedPositions` table does not exist

The plan lists `estimatedPositions` as a key in the ActiveSchema (line 348) and in the test (line 254). There is no `estimatedPositions*` export in any schema file -- `grep -n 'estimatedPosition' src/db/schema/misc.ts` returns nothing.

**Fix:** Remove `estimatedPositions` from the schema map, or identify what table this was intended to reference.

### C6: Migration number collision risk

The plan proposes migration 087 (Phase 0), but the latest migration is 086. If another PR lands first and takes 087, this will collide. The plan should note that the migration number must be verified against HEAD at implementation time.

---

## Important Issues (Should Fix)

### I1: Phase 3 Option C understates complexity

The plan recommends Option C (remove raw SQL, rely solely on migration chain from 001). But it then acknowledges in Step 10 that migrations 001-046 only have SQLite `migration.up()` functions and need Postgres/MySQL backfills. This is not "simplest" -- it requires writing ~46 new migration functions. The effort estimate of "Medium (1 PR)" is significantly understated for this phase.

**Recommendation:** Either keep the raw SQL files as generated artifacts (Option A/B), or break Phase 3 into multiple PRs and re-estimate as "Large."

### I2: Migration registry `getFrom()` assumes contiguous numbering starting from 1

The registry enforces sequential numbering (`entry.number !== last.number + 1`), but `getFrom(47)` in Phase 2 Step 8 assumes the first migration registered is number 1. If someone registers starting at 47, the sequential check will fail on the first registration because there is no "previous" migration and the check `this.migrations.length > 0` passes only after the first entry.

Wait -- actually re-reading the code, the sequential check only runs when `this.migrations.length > 0`, so the first registration always succeeds regardless of its number. This means `registry.register({ number: 47, ... })` would work, but then registering 48 would also work. However, you could then register 47 as the first and 49 as the second, and the check `entry.number !== last.number + 1` (49 !== 48) would correctly throw. So the check is correct for preventing gaps, but it does NOT prevent starting at an arbitrary number. This is fine if the intent is to start at 1, but the plan should add a test for that invariant.

### I3: SQLite migration idempotency complexity underspecified

Phase 2 Step 7 shows a simple loop for SQLite migrations, but the current codebase uses two patterns: (a) old migrations (001-046) that call `migration.up()` with internal idempotency, and (b) new migrations (047+) that use a `settingsKey` guard. The registry loop must handle both. The plan's note says "study each migration" but does not provide a concrete strategy. An implementer without context would likely break existing idempotency.

**Recommendation:** Add a `selfIdempotent: boolean` flag to `MigrationEntry` for migrations that handle their own idempotency checks internally. The loop skips the settings-key guard for those.

### I4: `any` typing on `this.db` may break Drizzle's `.execute()` and `.run()` methods

The plan proposes `protected readonly db: any` in BaseRepository. While `.select().from()` chains work identically across dialects at runtime, some Drizzle methods have dialect-specific signatures (e.g., SQLite's synchronous `.get()` vs Postgres's async `.execute()`). Methods that use these will silently lose type safety.

**Recommendation:** Document in the BaseRepository JSDoc that `this.db` is untyped and that dialect-specific operations must use the typed `sqliteDb/postgresDb/mysqlDb` accessors. The plan mentions this but the BaseRepository code sample does not include the JSDoc.

---

## Suggestions (Nice to Have)

### S1: Add a compile-time completeness check for ActiveSchema

Since the SCHEMA_MAP uses `any` types, nothing prevents a table from being silently omitted. Consider adding a build-time script or test that compares the keys in SCHEMA_MAP against all `export const *Sqlite` names found via a grep of `src/db/schema/*.ts`.

### S2: Phase 4 incremental migration could use a deprecation pattern

When migrating callers from `databaseService.getNodeAsync()` to `databaseService.nodes.getNode()`, mark the old wrappers with `@deprecated` JSDoc tags and a `console.warn` in development mode, rather than keeping them silently working.

### S3: Phase 5 CI PostgreSQL should also test MySQL

The plan adds PostgreSQL to CI but not MySQL. Given that MySQL has its own dialect quirks (different upsert syntax, different boolean handling), consider adding a MySQL service as well, or at minimum note it as future work.

---

## What Was Done Well

- The BIGINT bug identification in Phase 0 is precise, with correct line references for messages.ts.
- The Active Schema Map concept correctly exploits Drizzle's runtime API homogeneity.
- The migration registry directly addresses the root cause of the PR #2301 bug class.
- The plan correctly identifies which ~15 methods must retain branching (dialect-specific SQL).
- Phase sequencing with explicit dependency declarations is clear.
- The "convert one repository as proof of concept" approach in Phase 1 is prudent.

---

## Summary

| Category | Count |
|---|---|
| Critical (must fix) | 6 |
| Important (should fix) | 4 |
| Suggestions | 3 |

The plan is fundamentally sound but has concrete naming errors (C1-C3), missing tables (C4-C5), and underspecified complexity in Phase 3. An engineer would be blocked within the first hour without fixes to C1-C5. Recommend updating the plan before beginning implementation.
