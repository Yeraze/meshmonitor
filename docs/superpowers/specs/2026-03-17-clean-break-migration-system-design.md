# Clean Break Migration System — Design Spec

## Goal

Replace the current 87-migration frankenstack (46 SQLite-only + 41 tri-backend) with a clean v3.7 baseline plus 10 uniform post-baseline migrations. Delete raw SQL schema files entirely. Fix all known schema drift. Unblock AuthRepository for SQLite.

## Background

MeshMonitor supports SQLite, PostgreSQL, and MySQL. The current migration system has two eras:
- **Migrations 001-046**: SQLite-only. PG/MySQL rely on static raw SQL files (`postgres-create.ts`, `mysql-create.ts`) for base schema.
- **Migrations 047-087**: Tri-backend with proper functions for all 3 databases.

This dual approach causes recurring schema drift (4 fix-the-fix migrations so far) and blocks AuthRepository initialization on SQLite due to column naming/presence mismatches.

## Approach

**Clean break at v3.7 (migration 077).** Instead of backfilling 46 old migrations with PG/MySQL functions, create a single baseline migration that establishes the complete v3.7 schema for all 3 backends, then carry forward only the 10 post-v3.7 migrations.

### Minimum Version Requirement

Users must be on v3.7+ before upgrading to any version with this change. Pre-3.7 databases are detected at startup and shown a clear error message.

## Design

### 1. Pre-3.7 Detection

Before running migrations, check for the settings key `migration_077_ignored_nodes_nodenum_bigint`.

- **Key exists**: Database is v3.7+ — proceed normally.
- **Key missing + database exists**: Pre-3.7 — log error and exit:
  ```
  ERROR: This version requires MeshMonitor v3.7 or later.
  Please upgrade to v3.7 first, then upgrade to this version.
  ```
- **No database (fresh install)**: Proceed normally — baseline creates everything.

For PostgreSQL/MySQL, check if the `ignored_nodes` table exists (present since v3.7). If the database has tables but no `ignored_nodes`, it's pre-3.7.

### 2. Baseline Migration (New 001)

`src/server/migrations/001_v37_baseline.ts`

Creates the complete v3.7 schema (35 tables) for all 3 backends:

- **SQLite**: Check if settings table exists. If yes and migration 077 key is present, this is an existing v3.7+ database — skip entirely. If settings table doesn't exist, this is a fresh install — create all tables.
- **PostgreSQL**: `CREATE TABLE IF NOT EXISTS` for all 32 tables with correct column types, indexes, and constraints. Derived from current `POSTGRES_SCHEMA_SQL` content.
- **MySQL**: Same as PostgreSQL with MySQL syntax. Derived from current `MYSQL_SCHEMA_SQL` content.

The baseline creates tables in their **v3.7 final state** — including all columns added by migrations 001-077. This means columns like `transport_mechanism` (added in migration 058), BIGINT `packetId` (migration 075), BIGINT `nodeNum` on `ignored_nodes` (migration 077) are all present from the start.

### 3. Post-Baseline Migrations (New 002-011)

These are the current migrations 078-087, renumbered:

| New # | Old # | Name | Backends |
|-------|-------|------|----------|
| 002 | 078 | create_embed_profiles | SQLite, PG, MySQL |
| 003 | 079 | create_geofence_cooldowns | SQLite, PG, MySQL |
| 004 | 080 | add_favorite_locked | SQLite, PG, MySQL |
| 005 | 081 | add_time_offset_columns | SQLite, PG, MySQL |
| 006 | 082 | add_packetmonitor_permission | SQLite, PG, MySQL |
| 007 | 083 | add_missing_map_preference_columns | SQLite, PG, MySQL |
| 008 | 084 | add_key_mismatch_columns | SQLite, PG, MySQL |
| 009 | 085 | fix_custom_themes_columns | SQLite, PG, MySQL |
| 010 | 086 | add_auto_distance_delete_log | SQLite, PG, MySQL |
| 011 | 087 | fix_message_nodenum_bigint | SQLite, PG, MySQL |

Each migration retains its existing `settingsKey` for idempotency.

### 4. Auth Schema Alignment (New 012)

`src/server/migrations/012_align_sqlite_auth_schema.ts`

Fixes all known SQLite auth schema drift so AuthRepository can initialize:

| Fix | SQLite Change |
|-----|--------------|
| `users.updatedAt` missing | `ALTER TABLE users ADD COLUMN updated_at INTEGER` |
| `permissions.canDelete` missing | `ALTER TABLE permissions ADD COLUMN can_delete INTEGER DEFAULT 0` |
| `permissions.grantedAt/grantedBy` naming | Already present as `granted_at`/`granted_by` — no change needed for SQLite |
| `auth_provider` → `authMethod` | Rename column (SQLite 3.25+ supports `ALTER TABLE RENAME COLUMN`) |
| `notifyOnChannelMessage` missing from SQLite | `ALTER TABLE user_notification_preferences ADD COLUMN notify_on_channel_message INTEGER DEFAULT 1` |

For PostgreSQL/MySQL:
| Fix | PG/MySQL Change |
|-----|----------------|
| `permissions.grantedAt/grantedBy` missing | `ALTER TABLE permissions ADD COLUMN IF NOT EXISTS "grantedAt"` / `"grantedBy"` |
| `neighbor_info.snr` type mismatch | PG: `ALTER COLUMN snr TYPE DOUBLE PRECISION` |
| `backup_history.fileSize` type mismatch | PG/MySQL: `ALTER COLUMN fileSize TYPE BIGINT` |

### 5. Drizzle Schema Additions

Add Drizzle schema definitions for the 5 tables that exist only in raw SQL with no Drizzle schema:

| Table | Add to Schema File |
|-------|-------------------|
| `auto_traceroute_log` | `misc.ts` |
| `auto_key_repair_state` | `misc.ts` |
| `auto_key_repair_log` | `misc.ts` |
| `auto_distance_delete_log` | `misc.ts` |
| `geofence_cooldowns` | `misc.ts` |

These 5 tables are accessed via raw SQL today. Adding Drizzle schemas enables type-safe access and inclusion in the active schema map.

The remaining 27 tables already have Drizzle schemas in their respective files (`nodes.ts`, `messages.ts`, `auth.ts`, `misc.ts`, `packets.ts`, `notifications.ts`, `traceroutes.ts`, etc.). Add any newly-defined tables to `activeSchema.ts`.

### 6. Files Deleted

- `src/db/schema/postgres-create.ts` — raw PG SQL
- `src/db/schema/mysql-create.ts` — raw MySQL SQL
- `src/server/migrations/001_add_auth_tables.ts` through `077_upgrade_ignored_nodes_nodenum_bigint.ts` — all 77 old migration files

### 7. Files Modified

- `src/db/migrations.ts` — re-register 12 migrations instead of 87
- `src/db/activeSchema.ts` — add any newly-defined tables
- `src/services/database.ts`:
  - Add pre-3.7 detection before migration loop
  - Simplify `createPostgresSchema()` to just run the registry loop (no more `POSTGRES_SCHEMA_SQL` call)
  - Simplify `createMySQLSchema()` same way
  - Remove imports of `POSTGRES_SCHEMA_SQL`, `MYSQL_SCHEMA_SQL`
- `src/db/migrations.test.ts` — update expected migration count
- `src/db/repositories/schemaIntegrity.test.ts` — update to work with new migration numbering

### 8. Existing Database Upgrade Path

**SQLite (v3.7+):**
1. Pre-3.7 check passes (migration_077 key exists in settings)
2. Baseline migration 001: Detects existing database, skips table creation
3. Migrations 002-011: Run normally with settingsKey guards. Migrations that already ran (same settingsKey as old 078-087) are skipped.
4. Migration 012: Applies auth schema fixes

**PostgreSQL/MySQL (v3.7+):**
1. Pre-3.7 check passes (`ignored_nodes` table exists)
2. Baseline migration 001: `CREATE TABLE IF NOT EXISTS` — all tables already exist, no-ops
3. Migrations 002-011: Run with `information_schema` idempotency checks. Already-applied changes are skipped.
4. Migration 012: Applies schema drift fixes

**Fresh Install (any backend):**
1. Pre-3.7 check: No database — proceed
2. Baseline migration 001: Creates all 32 tables
3. Migrations 002-012: Apply all post-v3.7 changes

**Pre-3.7 Database:**
1. Pre-3.7 check fails — error message, exit

## Risk Mitigation

- **Settings key continuity**: Post-baseline migrations keep their original settingsKeys (e.g., migration 002 uses `migration_078_embed_profiles`, same as old migration 078). This prevents re-running on existing v3.7+ SQLite databases.
- **Schema integrity test**: Updated to create fresh DB via baseline + all migrations and verify critical columns exist.
- **All 3 backends tested**: Docker verification for SQLite, PostgreSQL, MySQL before merge.

## Success Criteria

- Fresh installs work on all 3 backends
- Upgrade from v3.7+ works on all 3 backends with no data loss
- Pre-3.7 databases get clear error message
- `postgres-create.ts` and `mysql-create.ts` deleted
- AuthRepository initializes for SQLite
- Migration file count: 77 → 12
- Schema drift issues: 8 → 0
- Sources of schema truth: 2 → 1 (Drizzle only)
