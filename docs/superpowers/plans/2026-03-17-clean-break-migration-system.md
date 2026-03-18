# Clean Break Migration System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 87-migration frankenstack with a v3.7 baseline + 10 uniform post-baseline migrations, delete raw SQL schema files, fix auth schema drift, and unblock AuthRepository for SQLite.

**Architecture:** A single baseline migration creates the complete v3.7 schema (35 tables) for all 3 backends. Post-baseline migrations 078-087 are renumbered 002-011 and carry forward unchanged. A new migration 012 aligns SQLite auth schema with PG/MySQL. The raw SQL files (`postgres-create.ts`, `mysql-create.ts`) and all 77 old migration files are deleted.

**Tech Stack:** Drizzle ORM 0.45.1, TypeScript, better-sqlite3, pg, mysql2, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-clean-break-migration-system-design.md`

---

## File Structure

### New Files
- `src/server/migrations/001_v37_baseline.ts` — Creates complete v3.7 schema for all 3 backends
- `src/server/migrations/002_create_embed_profiles.ts` — Renamed from 078
- `src/server/migrations/003_create_geofence_cooldowns.ts` — Renamed from 079
- `src/server/migrations/004_add_favorite_locked.ts` — Renamed from 080
- `src/server/migrations/005_add_time_offset_columns.ts` — Renamed from 081
- `src/server/migrations/006_add_packetmonitor_permission.ts` — Renamed from 082
- `src/server/migrations/007_add_missing_map_preference_columns.ts` — Renamed from 083
- `src/server/migrations/008_add_key_mismatch_columns.ts` — Renamed from 084
- `src/server/migrations/009_fix_custom_themes_columns.ts` — Renamed from 085
- `src/server/migrations/010_add_auto_distance_delete_log.ts` — Renamed from 086
- `src/server/migrations/011_fix_message_nodenum_bigint.ts` — Renamed from 087
- `src/server/migrations/012_align_sqlite_auth_schema.ts` — Fix SQLite auth drift

### Modified Files
- `src/db/schema/misc.ts` — Add Drizzle schemas for 5 missing tables
- `src/db/activeSchema.ts` — Add 5 new table mappings
- `src/db/activeSchema.test.ts` — Add new tables to key name test
- `src/db/migrations.ts` — Re-register 12 migrations instead of 87
- `src/db/migrations.test.ts` — Update expected counts and classification
- `src/services/database.ts` — Add pre-3.7 detection, simplify PG/MySQL init, remove raw SQL imports
- `src/db/repositories/schemaIntegrity.test.ts` — Update for new migration numbering

### Deleted Files
- `src/db/schema/postgres-create.ts`
- `src/db/schema/mysql-create.ts`
- `src/server/migrations/001_add_auth_tables.ts` through `077_upgrade_ignored_nodes_nodenum_bigint.ts` (77 files)

---

## Chunk 1: Add Drizzle Schemas for 5 Missing Tables

### Task 1: Add Drizzle schema definitions

**Files:**
- Modify: `src/db/schema/misc.ts`
- Modify: `src/db/activeSchema.ts`
- Modify: `src/db/activeSchema.test.ts`

- [ ] **Step 1: Add 5 table schemas to misc.ts**

Add triple-definition (SQLite/Postgres/MySQL) for each table. Match the column types exactly from `postgres-create.ts`. Tables to add:

1. `autoTracerouteLog` — id, timestamp, toNodeNum (BIGINT), toNodeName, success, createdAt
2. `autoKeyRepairState` — nodeNum (BIGINT PK), attemptCount, lastAttemptTime, exhausted, startedAt
3. `autoKeyRepairLog` — id, timestamp, nodeNum (BIGINT), nodeName, action, success, createdAt
4. `autoDistanceDeleteLog` — id, timestamp, nodesDeleted, thresholdKm (REAL), details, createdAt
5. `geofenceCooldowns` — triggerId (TEXT), nodeNum (BIGINT), firedAt — composite PK (triggerId, nodeNum)

Follow the existing pattern in misc.ts: `xxxSqlite`, `xxxPostgres`, `xxxMysql` exports. Use appropriate types per dialect (integer/pgBigint/myBigint for BIGINT, text/pgText/myVarchar for TEXT, etc.).

> **Already verified:** The other tables from the raw SQL files (`auto_traceroute_nodes`, `auto_time_sync_nodes`, `packet_log`, `push_subscriptions`, `read_messages`, `route_segments`, `solar_estimates`, `news_cache`, `user_news_status`) already have Drizzle definitions in `misc.ts`, `packets.ts`, `notifications.ts`, or `traceroutes.ts` — do NOT re-create them.

> **Note for implementer:** Read the existing `autoTracerouteNodesSqlite`/`autoTracerouteNodesPostgres`/`autoTracerouteNodesMysql` definitions in misc.ts as a template for the naming and style conventions.

- [ ] **Step 2: Add new tables to activeSchema.ts**

Import the new exports and add them to the `SCHEMA_MAP` for all 3 dialects:
```typescript
autoTracerouteLog: autoTracerouteLogSqlite, // (and Postgres/MySQL variants)
autoKeyRepairState: autoKeyRepairStateSqlite,
autoKeyRepairLog: autoKeyRepairLogSqlite,
autoDistanceDeleteLog: autoDistanceDeleteLogSqlite,
geofenceCooldowns: geofenceCooldownsSqlite,
```

Also add these to the `ActiveSchema` interface.

- [ ] **Step 3: Update activeSchema.test.ts**

Add the 5 new table keys to the "uses correct key names for commonly misnamed tables" test:
```typescript
expect(schema).toHaveProperty('autoTracerouteLog');
expect(schema).toHaveProperty('autoKeyRepairState');
expect(schema).toHaveProperty('autoKeyRepairLog');
expect(schema).toHaveProperty('autoDistanceDeleteLog');
expect(schema).toHaveProperty('geofenceCooldowns');
```

Update the key count assertion (was `>= 33`, should be `>= 38`).

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/db/activeSchema.test.ts
npm test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/misc.ts src/db/activeSchema.ts src/db/activeSchema.test.ts
git commit -m "feat: add Drizzle schema definitions for 5 tables previously only in raw SQL"
```

---

## Chunk 2: Create Baseline Migration

### Task 2: Write the v3.7 baseline migration

**Files:**
- Create: `src/server/migrations/001_v37_baseline.ts`

This is the largest single file in the plan. It contains the complete v3.7 schema (35 tables) for all 3 backends.

- [ ] **Step 1: Create the baseline migration file**

`src/server/migrations/001_v37_baseline.ts`:

```typescript
/**
 * Migration 001: v3.7 Baseline Schema
 *
 * Creates the complete MeshMonitor v3.7 schema for all 3 backends.
 * This replaces the old 77-migration chain (001-077) with a single
 * baseline that establishes the schema in its v3.7 final state.
 *
 * For existing v3.7+ databases: all CREATE TABLE IF NOT EXISTS statements
 * are no-ops (tables already exist).
 *
 * For fresh installs: creates all 35 tables from scratch.
 */
```

**SQLite function:**
- Check if `settings` table exists (via `sqlite_master`). If it does AND the key `migration_077_ignored_nodes_nodenum_bigint` exists, this is an existing v3.7+ DB — skip.
- If `settings` table doesn't exist, this is fresh — create ALL 35 tables using `CREATE TABLE IF NOT EXISTS`.
- The SQLite CREATE TABLE statements should match the current Drizzle schema definitions exactly (camelCase for most tables, snake_case for auth tables — matching existing column names).

**PostgreSQL function:**
- Content is the current `POSTGRES_SCHEMA_SQL` from `postgres-create.ts` (all `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
- Include the migration 056 fix (backup_history column renames) inline, since that special-case ordering is no longer needed when it's part of the baseline.

**MySQL function:**
- Content is the current `MYSQL_SCHEMA_SQL` from `mysql-create.ts`.
- Execute statement by statement (MySQL doesn't support multi-statement).
- Ignore `ER_DUP_KEYNAME` errors for idempotent index creation.

> **Note for implementer:** Read `src/db/schema/postgres-create.ts` and `src/db/schema/mysql-create.ts` to get the exact SQL. Copy it into the migration functions. For SQLite, generate equivalent CREATE TABLE statements from the Drizzle schema files in `src/db/schema/` — use the SQLite column types (integer, text, real) and the existing column naming conventions.

- [ ] **Step 2: Run build check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

- [ ] **Step 3: Commit**

```bash
git add src/server/migrations/001_v37_baseline.ts
git commit -m "feat: add v3.7 baseline migration for all 3 backends

Creates the complete v3.7 schema (35 tables) in a single migration.
For existing v3.7+ databases, all statements are idempotent no-ops.
For fresh installs, creates everything from scratch."
```

---

## Chunk 3: Renumber Migrations and Update Registry

### Task 3: Rename post-baseline migrations

**Files:**
- Rename: `src/server/migrations/078_*.ts` → `002_*.ts` (and so on for 079-087)
- Modify: `src/db/migrations.ts`
- Modify: `src/db/migrations.test.ts`

> **Note:** The spec's migration name table has some incorrect names (e.g., lists "add_news_cache" for 079 which is actually "create_geofence_cooldowns"). The file names in THIS plan are correct — they match the actual migration files.

- [ ] **Step 1: Delete old migration files (001-077) FIRST**

```bash
cd src/server/migrations
rm 001_add_auth_tables.ts 002_*.ts 003_*.ts 004_*.ts 005_*.ts 006_*.ts 007_*.ts 008_*.ts 009_*.ts 010_*.ts 011_*.ts 012_*.ts 013_*.ts 014_*.ts 015_*.ts 016_*.ts 017_*.ts 018_*.ts 019_*.ts 020_*.ts 021_*.ts 022_*.ts 023_*.ts 024_*.ts 025_*.ts 026_*.ts 027_*.ts 028_*.ts 029_*.ts 030_*.ts 031_*.ts 032_*.ts 033_*.ts 034_*.ts 035_*.ts 036_*.ts 037_*.ts 038_*.ts 039_*.ts 040_*.ts 041_*.ts 042_*.ts 043_*.ts 044_*.ts 045_*.ts 046_*.ts 047_*.ts 048_*.ts 049_*.ts 050_*.ts 051_*.ts 052_*.ts 053_*.ts 054_*.ts 055_*.ts 056_*.ts 057_*.ts 058_*.ts 059_*.ts 060_*.ts 061_*.ts 062_*.ts 063_*.ts 064_*.ts 065_*.ts 066_*.ts 067_*.ts 068_*.ts 069_*.ts 070_*.ts 071_*.ts 072_*.ts 073_*.ts 074_*.ts 075_*.ts 076_*.ts 077_*.ts
```

- [ ] **Step 2: Rename post-baseline migration files (078-087 → 002-011)**

```bash
cd src/server/migrations
mv 078_create_embed_profiles.ts 002_create_embed_profiles.ts
mv 079_create_geofence_cooldowns.ts 003_create_geofence_cooldowns.ts
mv 080_add_favorite_locked.ts 004_add_favorite_locked.ts
mv 081_add_time_offset_columns.ts 005_add_time_offset_columns.ts
mv 082_add_packetmonitor_permission.ts 006_add_packetmonitor_permission.ts
mv 083_add_missing_map_preference_columns.ts 007_add_missing_map_preference_columns.ts
mv 084_add_key_mismatch_columns.ts 008_add_key_mismatch_columns.ts
mv 085_fix_custom_themes_columns.ts 009_fix_custom_themes_columns.ts
mv 086_add_auto_distance_delete_log.ts 010_add_auto_distance_delete_log.ts
mv 087_fix_message_nodenum_bigint.ts 011_fix_message_nodenum_bigint.ts
```

- [ ] **Step 3: Rewrite src/db/migrations.ts**

Replace the entire file. The new version registers only 12 migrations:

```typescript
import { MigrationRegistry } from './migrationRegistry.js';

// Baseline
import { migration as baselineMigration, runMigration001Postgres, runMigration001Mysql } from '../server/migrations/001_v37_baseline.js';

// Post-baseline (002-011, formerly 078-087)
import { ... } from '../server/migrations/002_create_embed_profiles.js';
// ... (one import per migration)

// Auth schema alignment
import { ... } from '../server/migrations/012_align_sqlite_auth_schema.js';

export const registry = new MigrationRegistry();

// Migration 001: v3.7 Baseline
registry.register({
  number: 1,
  name: 'v37_baseline',
  selfIdempotent: true, // Handles its own detection of existing v3.7+ DBs
  sqlite: (db) => baselineMigration.up(db),
  postgres: (client) => runMigration001Postgres(client),
  mysql: (pool) => runMigration001Mysql(pool),
});

// Migration 002: Create embed profiles (formerly 078)
registry.register({
  number: 2,
  name: 'create_embed_profiles',
  settingsKey: 'migration_078_create_embed_profiles', // Keep original key!
  sqlite: (db, getSetting, setSetting) => runMigration002Sqlite(db),
  postgres: (client) => runMigration002Postgres(client),
  mysql: (pool) => runMigration002Mysql(pool),
});

// ... repeat for 003-011 with their ORIGINAL settingsKeys ...

// Migration 012: Align SQLite auth schema
registry.register({
  number: 12,
  name: 'align_sqlite_auth_schema',
  settingsKey: 'migration_012_align_sqlite_auth_schema',
  sqlite: (db) => runMigration012Sqlite(db),
  postgres: (client) => runMigration012Postgres(client),
  mysql: (pool) => runMigration012Mysql(pool),
});
```

**CRITICAL:** Each migration 002-011 MUST use its ORIGINAL settingsKey (e.g., `migration_078_create_embed_profiles` for migration 002). This prevents re-running on existing v3.7+ SQLite databases.

> **Note for implementer:** Read the current `src/db/migrations.ts` to get the exact import names and settingsKeys for migrations 078-087. The function export names inside the migration files don't change — only the file names change. Update the import paths accordingly.

- [ ] **Step 4: Update src/db/migrations.test.ts**

Update expected values:
- Total count: 12 (was 87)
- First migration: number 1, name contains 'v37_baseline'
- Last migration: number 12, name contains 'align_sqlite_auth'
- Only migration 1 is selfIdempotent (rest have settingsKeys)
- All migrations have at least one function

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/db/migrations.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: renumber migrations, delete 77 old files, update registry

Post-baseline migrations 078-087 renamed to 002-011.
Old migrations 001-077 deleted (replaced by baseline).
Registry updated: 12 migrations instead of 87.
Original settingsKeys preserved for upgrade compatibility."
```

---

## Chunk 4: Auth Schema Alignment Migration

### Task 4: Write migration 012

**Files:**
- Create: `src/server/migrations/012_align_sqlite_auth_schema.ts`

- [ ] **Step 1: Create the auth alignment migration**

`src/server/migrations/012_align_sqlite_auth_schema.ts`:

**SQLite function:**
```typescript
// 1. Add missing updatedAt column to users
db.exec(`ALTER TABLE users ADD COLUMN updated_at INTEGER`);
// (wrap in try/catch — may already exist)

// 2. Add missing canDelete column to permissions
db.exec(`ALTER TABLE permissions ADD COLUMN can_delete INTEGER NOT NULL DEFAULT 0`);
// (wrap in try/catch)

// 3. Rename auth_provider to authMethod
// SQLite 3.25+ supports ALTER TABLE RENAME COLUMN
db.exec(`ALTER TABLE users RENAME COLUMN auth_provider TO authMethod`);
// (wrap in try/catch — may already be renamed)

// 4. Add missing notifyOnChannelMessage to notification preferences
db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN notify_on_channel_message INTEGER NOT NULL DEFAULT 1`);
// (wrap in try/catch)
```

> **Note for implementer:** Each ALTER TABLE should be wrapped in its own try/catch so that if the column already exists (duplicate column error), the migration continues. Log debug messages for each step. Use `PRAGMA table_info(tablename)` to check column existence before altering if you prefer a check-first approach.

**PostgreSQL function:**
```typescript
// 1. Add missing grantedAt/grantedBy to permissions
await client.query(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "grantedAt" BIGINT`);
await client.query(`ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "grantedBy" INTEGER`);

// 2. Fix neighbor_info.snr type (REAL -> DOUBLE PRECISION)
const snrCheck = await client.query(`
  SELECT data_type FROM information_schema.columns
  WHERE table_name = 'neighbor_info' AND column_name = 'snr'
`);
if (snrCheck.rows[0]?.data_type === 'real') {
  await client.query(`ALTER TABLE neighbor_info ALTER COLUMN snr TYPE DOUBLE PRECISION`);
}

// 3. Fix backup_history.fileSize type (INTEGER -> BIGINT)
const fileSizeCheck = await client.query(`
  SELECT data_type FROM information_schema.columns
  WHERE table_name = 'backup_history' AND column_name = 'fileSize'
`);
if (fileSizeCheck.rows[0]?.data_type === 'integer') {
  await client.query(`ALTER TABLE backup_history ALTER COLUMN "fileSize" TYPE BIGINT`);
}
```

**MySQL function:**
```typescript
// 1. Add missing grantedAt/grantedBy to permissions
const [grantedAtRows]: any = await pool.query(`
  SELECT COLUMN_NAME FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'permissions' AND COLUMN_NAME = 'grantedAt'
`);
if (grantedAtRows.length === 0) {
  await pool.query(`ALTER TABLE permissions ADD COLUMN grantedAt BIGINT`);
  await pool.query(`ALTER TABLE permissions ADD COLUMN grantedBy INT`);
}

// 2. Fix backup_history.fileSize (INT -> BIGINT)
const [fileSizeRows]: any = await pool.query(`
  SELECT DATA_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'backup_history' AND COLUMN_NAME = 'fileSize'
`);
if (fileSizeRows.length > 0 && fileSizeRows[0].DATA_TYPE === 'int') {
  await pool.query(`ALTER TABLE backup_history MODIFY COLUMN fileSize BIGINT`);
}
```

- [ ] **Step 2: Run build check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

- [ ] **Step 3: Commit**

```bash
git add src/server/migrations/012_align_sqlite_auth_schema.ts
git commit -m "feat: add auth schema alignment migration

Fixes SQLite: adds updatedAt to users, canDelete to permissions,
renames auth_provider to authMethod, adds notifyOnChannelMessage.
Fixes PG/MySQL: adds grantedAt/grantedBy to permissions,
upgrades neighbor_info.snr and backup_history.fileSize types."
```

---

## Chunk 5: Simplify database.ts and Delete Raw SQL Files

### Task 5: Add pre-3.7 detection and simplify init

**Files:**
- Modify: `src/services/database.ts`
- Delete: `src/db/schema/postgres-create.ts`
- Delete: `src/db/schema/mysql-create.ts`

- [ ] **Step 1: Add pre-3.7 detection to SQLite initialize()**

In `src/services/database.ts`, in the `initialize()` method, BEFORE the migration registry loop, add:

```typescript
// Detect pre-3.7 databases that need a two-step upgrade
try {
  const tables = this.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
  ).all();
  if (tables.length > 0) {
    // Database exists — check if it's v3.7+
    const migrationKey = this.getSetting('migration_077_ignored_nodes_nodenum_bigint');
    if (!migrationKey) {
      logger.error('═══════════════════════════════════════════════════════════');
      logger.error('  This version requires MeshMonitor v3.7 or later.');
      logger.error('  Please upgrade to v3.7 first, then upgrade to this version.');
      logger.error('═══════════════════════════════════════════════════════════');
      throw new Error('Database is pre-v3.7. Please upgrade to v3.7 first.');
    }
  }
  // If no settings table, this is a fresh install — proceed normally
} catch (err: any) {
  if (err.message?.includes('pre-v3.7')) throw err;
  // No settings table = fresh install, continue
}
```

- [ ] **Step 2: Simplify createPostgresSchema()**

Replace the current method body with:

```typescript
private async createPostgresSchema(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    // Check for pre-3.7 database
    const result = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ignored_nodes'
      ) as exists
    `);
    const hasIgnoredNodes = result.rows[0]?.exists;

    // Check if ANY tables exist (to distinguish pre-3.7 from fresh)
    const tableCount = await client.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const hasAnyTables = parseInt(tableCount.rows[0]?.count || '0') > 0;

    if (hasAnyTables && !hasIgnoredNodes) {
      logger.error('═══════════════════════════════════════════════════════════');
      logger.error('  This version requires MeshMonitor v3.7 or later.');
      logger.error('  Please upgrade to v3.7 first, then upgrade to this version.');
      logger.error('═══════════════════════════════════════════════════════════');
      throw new Error('Database is pre-v3.7. Please upgrade to v3.7 first.');
    }

    // Run all migrations from the registry
    for (const migration of registry.getAll()) {
      if (migration.postgres) {
        await migration.postgres(client);
      }
    }
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Simplify createMySQLSchema()**

Same pattern as PostgreSQL, using MySQL syntax for the pre-3.7 check.

- [ ] **Step 4: Remove raw SQL imports**

Remove these imports from `database.ts`:
```typescript
import { POSTGRES_SCHEMA_SQL, POSTGRES_TABLE_NAMES } from '../db/schema/postgres-create.js';
import { MYSQL_SCHEMA_SQL, MYSQL_TABLE_NAMES } from '../db/schema/mysql-create.js';
```

Also remove any table verification code that used `POSTGRES_TABLE_NAMES` / `MYSQL_TABLE_NAMES`.

- [ ] **Step 5: Delete raw SQL files**

```bash
rm src/db/schema/postgres-create.ts src/db/schema/mysql-create.ts
```

- [ ] **Step 6: Update src/db/schema/index.ts if needed**

If `index.ts` re-exports from `postgres-create.ts` or `mysql-create.ts`, remove those exports.

- [ ] **Step 7: Run tests + build**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
npm test 2>&1 | tail -5
```

Fix any import errors from files that imported the deleted modules.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: simplify database init, delete raw SQL schema files

createPostgresSchema() and createMySQLSchema() now run migrations
from the registry instead of executing raw SQL. Pre-3.7 detection
added for all 3 backends. postgres-create.ts and mysql-create.ts
deleted — single source of truth is now Drizzle schemas + migrations."
```

---

## Chunk 6: Update Tests and Final Verification

### Task 6: Update schema integrity test

**Files:**
- Modify: `src/db/repositories/schemaIntegrity.test.ts`

- [ ] **Step 1: Update the test to work with new migration system**

The schema integrity test runs all migrations on a fresh in-memory SQLite DB. Update it to:
- Use the new 12-migration registry
- Verify baseline creates all expected tables
- Verify auth alignment migration applies correctly
- Keep all existing column existence checks

- [ ] **Step 2: Run the test**

```bash
npx vitest run src/db/repositories/schemaIntegrity.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories/schemaIntegrity.test.ts
git commit -m "test: update schema integrity test for clean break migration system"
```

### Task 7: Full verification

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -5
```
All tests must pass.

- [ ] **Step 5: Build check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```
Must be 0.

- [ ] **Step 6: Docker verification — fresh SQLite**

```bash
docker volume rm <project>_meshmonitor-sqlite-data 2>/dev/null
docker compose -f docker-compose.dev.yml --profile sqlite build
docker compose -f docker-compose.dev.yml --profile sqlite up -d
sleep 15
docker logs meshmonitor-sqlite 2>&1 | grep -iE "error|migration" | head -20
```
Expected: No errors, all migrations applied.

- [ ] **Step 7: Docker verification — fresh PostgreSQL**

```bash
docker compose -f docker-compose.dev.yml --profile sqlite down
docker compose -f docker-compose.dev.yml --profile postgres up -d
sleep 20
docker logs meshmonitor 2>&1 | grep -iE "error|migration" | head -20
```

- [ ] **Step 8: Docker verification — fresh MySQL**

```bash
docker compose -f docker-compose.dev.yml --profile postgres down
docker compose -f docker-compose.dev.yml --profile mysql up -d
sleep 20
docker logs meshmonitor-mysql-app 2>&1 | grep -iE "error|migration" | head -20
```

- [ ] **Step 9: Create PR**

```bash
git push -u origin <branch-name>
gh pr create --title "refactor: clean break migration system at v3.7 baseline" --body "..."
```
