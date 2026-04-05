/**
 * Migration Registry Barrel File
 *
 * Registers all 22 migrations in sequential order for use by the migration runner.
 * Migration 001 is the v3.7 baseline (selfIdempotent — handles its own detection).
 * Migrations 002-011 were originally 078-087 and retain their original settingsKeys
 * for upgrade compatibility.
 */

import { MigrationRegistry } from './migrationRegistry.js';

// === Migration 001: v3.7 baseline (replaces old 001-077) ===
import { migration as baselineMigration, runMigration001Postgres, runMigration001Mysql } from '../server/migrations/001_v37_baseline.js';

// === Migrations 002-011 (originally 078-087) ===
import { migration as createEmbedProfilesMigration, runMigration078Postgres, runMigration078Mysql } from '../server/migrations/002_create_embed_profiles.js';
import { migration as createGeofenceCooldownsMigration, runMigration079Postgres, runMigration079Mysql } from '../server/migrations/003_create_geofence_cooldowns.js';
import { migration as addFavoriteLockedMigration, runMigration080Postgres, runMigration080Mysql } from '../server/migrations/004_add_favorite_locked.js';
import { migration as addTimeOffsetColumnsMigration, runMigration081Postgres, runMigration081Mysql } from '../server/migrations/005_add_time_offset_columns.js';
import { migration as addPacketmonitorPermissionMigration, runMigration082Postgres, runMigration082Mysql } from '../server/migrations/006_add_packetmonitor_permission.js';
import { runMigration083Sqlite, runMigration083Postgres, runMigration083Mysql } from '../server/migrations/007_add_missing_map_preference_columns.js';
import { runMigration084Sqlite, runMigration084Postgres, runMigration084Mysql } from '../server/migrations/008_add_key_mismatch_columns.js';
import { migration as fixCustomThemesColumnsMigration, runMigration085Postgres, runMigration085Mysql } from '../server/migrations/009_fix_custom_themes_columns.js';
import { runMigration086Sqlite, runMigration086Postgres, runMigration086Mysql } from '../server/migrations/010_add_auto_distance_delete_log.js';
import { migration as fixMessageNodeNumBigintMigration, runMigration087Postgres, runMigration087Mysql } from '../server/migrations/011_fix_message_nodenum_bigint.js';
import { migration as authAlignMigration, runMigration012Postgres, runMigration012Mysql } from '../server/migrations/012_align_sqlite_auth_schema.js';
import { migration as auditLogColumnsMigration, runMigration013Postgres, runMigration013Mysql } from '../server/migrations/013_add_audit_log_missing_columns.js';
import { migration as messagesDecryptedByMigration, runMigration014Postgres, runMigration014Mysql } from '../server/migrations/014_add_messages_decrypted_by.js';
import { migration as notificationPrefsUniqueMigration, runMigration015Postgres, runMigration015Mysql } from '../server/migrations/015_add_notification_prefs_unique.js';
import { migration as renameSystemBackupColumnsMigration, runMigration016Postgres, runMigration016Mysql } from '../server/migrations/016_rename_system_backup_columns.js';
import { migration as apiTokensNameMigration, runMigration017Postgres, runMigration017Mysql } from '../server/migrations/017_add_api_tokens_name_column.js';
import { migration as addMuteColumnsMigration, runMigration018Postgres, runMigration018Mysql } from '../server/migrations/018_add_mute_columns.js';
import { migration as addChannelToTraceroutesMigration, runMigration019Postgres, runMigration019Mysql } from '../server/migrations/019_add_channel_to_traceroutes.js';
import { migration as createSourcesMigration, runMigration020Postgres, runMigration020Mysql } from '../server/migrations/020_create_sources.js';
import { migration as addSourceIdColumnsMigration, runMigration021Postgres, runMigration021Mysql } from '../server/migrations/021_add_source_id_columns.js';
import { migration as addSourceIdToPermissionsMigration, runMigration022Postgres, runMigration022Mysql } from '../server/migrations/022_add_source_id_to_permissions.js';
import { migration as multiSourceChannelsMigration, runMigration023Postgres, runMigration023Mysql } from '../server/migrations/023_multi_source_channels.js';

// ============================================================================
// Registry
// ============================================================================

export const registry = new MigrationRegistry();

// ---------------------------------------------------------------------------
// Migration 001: v3.7 baseline
// selfIdempotent — detects existing v3.7+ databases and skips automatically.
// ---------------------------------------------------------------------------

registry.register({
  number: 1,
  name: 'v37_baseline',
  selfIdempotent: true,
  sqlite: (db) => baselineMigration.up(db),
  postgres: (client) => runMigration001Postgres(client),
  mysql: (pool) => runMigration001Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migrations 002-011 (originally 078-087)
// These retain their original settingsKeys for upgrade compatibility.
// ---------------------------------------------------------------------------

registry.register({
  number: 2,
  name: 'create_embed_profiles',
  settingsKey: 'migration_078_create_embed_profiles',
  sqlite: (db) => createEmbedProfilesMigration.up(db),
  postgres: (client) => runMigration078Postgres(client),
  mysql: (pool) => runMigration078Mysql(pool),
});

registry.register({
  number: 3,
  name: 'create_geofence_cooldowns',
  settingsKey: 'migration_079_create_geofence_cooldowns',
  sqlite: (db) => createGeofenceCooldownsMigration.up(db),
  postgres: (client) => runMigration079Postgres(client),
  mysql: (pool) => runMigration079Mysql(pool),
});

registry.register({
  number: 4,
  name: 'add_favorite_locked',
  settingsKey: 'migration_080_add_favorite_locked',
  sqlite: (db) => addFavoriteLockedMigration.up(db),
  postgres: (client) => runMigration080Postgres(client),
  mysql: (pool) => runMigration080Mysql(pool),
});

registry.register({
  number: 5,
  name: 'add_time_offset_columns',
  settingsKey: 'migration_081_time_offset_columns',
  sqlite: (db) => addTimeOffsetColumnsMigration.up(db),
  postgres: (client) => runMigration081Postgres(client),
  mysql: (pool) => runMigration081Mysql(pool),
});

registry.register({
  number: 6,
  name: 'add_packetmonitor_permission',
  settingsKey: 'migration_082_packetmonitor_permission',
  sqlite: (db) => addPacketmonitorPermissionMigration.up(db),
  postgres: (client) => runMigration082Postgres(client),
  mysql: (pool) => runMigration082Mysql(pool),
});

registry.register({
  number: 7,
  name: 'add_missing_map_preference_columns',
  settingsKey: 'migration_083_map_preference_columns',
  sqlite: (db) => runMigration083Sqlite(db),
  postgres: (client) => runMigration083Postgres(client),
  mysql: (pool) => runMigration083Mysql(pool),
});

registry.register({
  number: 8,
  name: 'add_key_mismatch_columns',
  settingsKey: 'migration_084_key_mismatch_columns',
  sqlite: (db) => runMigration084Sqlite(db),
  postgres: (client) => runMigration084Postgres(client),
  mysql: (pool) => runMigration084Mysql(pool),
});

// Migration 009 is Postgres/MySQL only — SQLite migration is a no-op
registry.register({
  number: 9,
  name: 'fix_custom_themes_columns',
  settingsKey: 'migration_085_fix_custom_themes_columns',
  sqlite: (db) => fixCustomThemesColumnsMigration.up(db),
  postgres: (client) => runMigration085Postgres(client),
  mysql: (pool) => runMigration085Mysql(pool),
});

registry.register({
  number: 10,
  name: 'add_auto_distance_delete_log',
  settingsKey: 'migration_086_auto_distance_delete_log',
  sqlite: (db) => runMigration086Sqlite(db),
  postgres: (client) => runMigration086Postgres(client),
  mysql: (pool) => runMigration086Mysql(pool),
});

// Migration 011 is Postgres/MySQL only — SQLite migration is a no-op
registry.register({
  number: 11,
  name: 'fix_message_nodenum_bigint',
  settingsKey: 'migration_087_fix_message_nodenum_bigint',
  sqlite: (db) => fixMessageNodeNumBigintMigration.up(db),
  postgres: (client) => runMigration087Postgres(client),
  mysql: (pool) => runMigration087Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 012: Align auth schema across SQLite/PostgreSQL/MySQL
// ---------------------------------------------------------------------------

registry.register({
  number: 12,
  name: 'align_sqlite_auth_schema',
  settingsKey: 'migration_012_align_sqlite_auth_schema',
  sqlite: (db) => authAlignMigration.up(db),
  postgres: (client) => runMigration012Postgres(client),
  mysql: (pool) => runMigration012Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 013: Add missing ip_address/user_agent columns to audit_log
// Pre-3.7 SQLite databases may lack these columns.
// ---------------------------------------------------------------------------

registry.register({
  number: 13,
  name: 'add_audit_log_missing_columns',
  settingsKey: 'migration_013_add_audit_log_missing_columns',
  sqlite: (db) => auditLogColumnsMigration.up(db),
  postgres: (client) => runMigration013Postgres(client),
  mysql: (pool) => runMigration013Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 014: Add missing decrypted_by column to messages table
// PG/MySQL baselines omitted this column that the Drizzle schema expects.
// ---------------------------------------------------------------------------

registry.register({
  number: 14,
  name: 'add_messages_decrypted_by',
  settingsKey: 'migration_014_add_messages_decrypted_by',
  sqlite: (db) => messagesDecryptedByMigration.up(db),
  postgres: (client) => runMigration014Postgres(client),
  mysql: (pool) => runMigration014Mysql(pool),
});

// ---------------------------------------------------------------------------
// 015 — Add UNIQUE constraint to user_notification_preferences.userId
// The upsert for notification preferences requires this constraint.
// ---------------------------------------------------------------------------

registry.register({
  number: 15,
  name: 'add_notification_prefs_unique',
  settingsKey: 'migration_015_add_notification_prefs_unique',
  sqlite: (db) => notificationPrefsUniqueMigration.up(db),
  postgres: (client) => runMigration015Postgres(client),
  mysql: (pool) => runMigration015Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 016: Rename legacy system_backup_history columns
// Pre-3.7 databases used dirname/type/size/table_count/meshmonitor_version/
// schema_version; baseline CREATE TABLE IF NOT EXISTS didn't rename them.
// Fixes: https://github.com/Yeraze/meshmonitor/issues/2419
// ---------------------------------------------------------------------------

registry.register({
  number: 16,
  name: 'rename_system_backup_columns',
  settingsKey: 'migration_016_rename_system_backup_columns',
  sqlite: (db) => renameSystemBackupColumnsMigration.up(db),
  postgres: (client) => runMigration016Postgres(client),
  mysql: (pool) => runMigration016Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 017: Add missing name and expires_at columns to api_tokens
// Pre-3.7 databases created api_tokens without these columns.
// Fixes: https://github.com/Yeraze/meshmonitor/issues/2435
// ---------------------------------------------------------------------------

registry.register({
  number: 17,
  name: 'add_api_tokens_name_column',
  settingsKey: 'migration_017_add_api_tokens_name_column',
  sqlite: (db) => apiTokensNameMigration.up(db),
  postgres: (client) => runMigration017Postgres(client),
  mysql: (pool) => runMigration017Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 018: Add per-channel and per-DM mute columns to user_notification_preferences
// Implements per-source audio/push notification muting with optional expiry.
// Implements: https://github.com/Yeraze/meshmonitor/issues/2545
// ---------------------------------------------------------------------------

registry.register({
  number: 18,
  name: 'add_mute_columns',
  settingsKey: 'migration_018_add_mute_columns',
  sqlite: (db) => addMuteColumnsMigration.up(db),
  postgres: (client) => runMigration018Postgres(client),
  mysql: (pool) => runMigration018Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 019: Add channel column to traceroutes table
// Enables private-channel masking for traceroute data (MM-47).
// ---------------------------------------------------------------------------

registry.register({
  number: 19,
  name: 'add_channel_to_traceroutes',
  settingsKey: 'migration_019_add_channel_to_traceroutes',
  sqlite: (db) => addChannelToTraceroutesMigration.up(db),
  postgres: (client) => runMigration019Postgres(client),
  mysql: (pool) => runMigration019Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 020: Create sources table for multi-source support (4.0 Phase 1)
// ---------------------------------------------------------------------------

registry.register({
  number: 20,
  name: 'create_sources',
  settingsKey: 'migration_020_create_sources',
  sqlite: (db) => createSourcesMigration.up(db),
  postgres: (client) => runMigration020Postgres(client),
  mysql: (pool) => runMigration020Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 021: Add sourceId columns to all data tables (Phase 2)
// ---------------------------------------------------------------------------

registry.register({
  number: 21,
  name: 'add_source_id_columns',
  settingsKey: 'migration_021_add_source_id_columns',
  sqlite: (db) => addSourceIdColumnsMigration.up(db),
  postgres: (client) => runMigration021Postgres(client),
  mysql: (pool) => runMigration021Mysql(pool),
});

// Migration 022: Add sourceId to permissions table (Phase 3)
// ---------------------------------------------------------------------------

registry.register({
  number: 22,
  name: 'add_source_id_to_permissions',
  settingsKey: 'migration_022_add_source_id_to_permissions',
  sqlite: (db) => addSourceIdToPermissionsMigration.up(db),
  postgres: (client) => runMigration022Postgres(client),
  mysql: (pool) => runMigration022Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 023: Multi-source channels table rebuild
// Changes channels table PK to surrogate key + UNIQUE(sourceId, id) so each
// source has its own independent set of channel slots (0-7).
// ---------------------------------------------------------------------------

registry.register({
  number: 23,
  name: 'multi_source_channels',
  settingsKey: 'migration_023_multi_source_channels',
  sqlite: (db) => multiSourceChannelsMigration.up(db),
  postgres: (client) => runMigration023Postgres(client),
  mysql: (pool) => runMigration023Mysql(pool),
});
