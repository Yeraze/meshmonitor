/**
 * Migration Registry Barrel File
 *
 * Registers all 44 migrations in sequential order for use by the migration runner.
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
import { migration as addSourceIdToTracerouteTablesMigration, runMigration024Postgres, runMigration024Mysql } from '../server/migrations/024_add_source_id_to_traceroute_tables.js';
import { migration as addSourceIdToTimeSyncNodesMigration, runMigration025Postgres, runMigration025Mysql } from '../server/migrations/025_add_source_id_to_time_sync_nodes.js';
import { migration as addSourceIdToDistanceDeleteLogMigration, runMigration026Postgres, runMigration026Mysql } from '../server/migrations/026_add_source_id_to_distance_delete_log.js';
import { migration as addSourceIdToKeyRepairLogMigration, runMigration027Postgres, runMigration027Mysql } from '../server/migrations/027_add_source_id_to_key_repair_log.js';
import { migration as addSourceIdToNotificationsMigration, runMigration028Postgres, runMigration028Mysql } from '../server/migrations/028_add_source_id_to_notifications.js';
import { migration as nodesCompositePkMigration, runMigration029Postgres, runMigration029Mysql } from '../server/migrations/029_nodes_composite_pk.js';
import { migration as addSourceIdToRouteSegmentsMigration, runMigration030Postgres, runMigration030Mysql } from '../server/migrations/030_add_source_id_to_route_segments.js';
import { migration as dropLegacyNodesUniqueMigration, runMigration031Postgres, runMigration031Mysql } from '../server/migrations/031_drop_legacy_nodes_unique.js';
import { migration as telemetryPacketDedupeMigration, runMigration032Postgres, runMigration032Mysql } from '../server/migrations/032_telemetry_packet_dedupe.js';
import { migration as perSourcePermissionsMigration, runMigration033Postgres, runMigration033Mysql } from '../server/migrations/033_per_source_permissions.js';
import { migration as addViaStoreForwardMigration, runMigration034Postgres, runMigration034Mysql } from '../server/migrations/034_add_via_store_forward.js';
import { migration as addIsStoreForwardServerMigration, runMigration035Postgres, runMigration035Mysql } from '../server/migrations/035_add_is_store_forward_server.js';
import { migration as telemetryPerformanceIndexesMigration, runMigration036Postgres, runMigration036Mysql } from '../server/migrations/036_telemetry_performance_indexes.js';
import { migration as userMapPrefsIdMigration, runMigration037Postgres, runMigration037Mysql } from '../server/migrations/037_add_id_to_user_map_preferences.js';
import { migration as cleanupOrphanNotificationPrefsMigration, runMigration038Postgres, runMigration038Mysql } from '../server/migrations/038_cleanup_orphan_notification_prefs.js';
import { migration as purgeNullSourceIdTelemetryMigration, runMigration039Postgres, runMigration039Mysql } from '../server/migrations/039_purge_null_sourceid_telemetry.js';
import { migration as purgeNullSourceIdNeighborInfoMigration, runMigration040Postgres, runMigration040Mysql } from '../server/migrations/040_purge_null_sourceid_neighbor_info.js';
import { migration as dropLegacyTelemetryFkMigration, runMigration041Postgres, runMigration041Mysql } from '../server/migrations/041_drop_legacy_telemetry_nodes_fk.js';
import { migration as dropLegacyMessagesFkMigration, runMigration042Postgres, runMigration042Mysql } from '../server/migrations/042_drop_legacy_messages_nodes_fk.js';
import { migration as dropLegacyNeighborInfoFkMigration, runMigration043Postgres, runMigration043Mysql } from '../server/migrations/043_drop_legacy_neighbor_info_nodes_fk.js';
import { migration as dropLegacyTraceroutesFkMigration, runMigration044Postgres, runMigration044Mysql } from '../server/migrations/044_drop_legacy_traceroutes_nodes_fk.js';
import { migration as dropLegacyRouteSegmentsFkMigration, runMigration045Postgres, runMigration045Mysql } from '../server/migrations/045_drop_legacy_route_segments_nodes_fk.js';
import { migration as addUserMapPrefsIdSqliteMigration, runMigration046Postgres, runMigration046Mysql } from '../server/migrations/046_add_user_map_preferences_id_sqlite.js';
import { migration as addSelectedLayerMigration, runMigration047Postgres, runMigration047Mysql } from '../server/migrations/047_add_selected_layer_to_user_map_preferences.js';
import { migration as rebuildIgnoredNodesPerSourceMigration, runMigration048Postgres, runMigration048Mysql } from '../server/migrations/048_rebuild_ignored_nodes_per_source.js';
import { migration as perfCompositeIndexesMigration, runMigration049Postgres, runMigration049Mysql } from '../server/migrations/049_perf_composite_indexes.js';
import { migration as promoteGlobalsToDefaultSourceMigration, runMigration050Postgres, runMigration050Mysql } from '../server/migrations/050_promote_globals_to_default_source.js';
import { migration as dropLegacyNotifPrefsUserIdUniqueMigration, runMigration051Postgres, runMigration051Mysql } from '../server/migrations/051_drop_legacy_notif_prefs_userid_unique.js';

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

// ---------------------------------------------------------------------------
// Migration 024: Per-source auto-traceroute scheduler (Phase 2b)
// Adds sourceId to auto_traceroute_nodes and auto_traceroute_log, replaces
// UNIQUE(nodeNum) with UNIQUE(nodeNum, sourceId).
// ---------------------------------------------------------------------------

registry.register({
  number: 24,
  name: 'add_source_id_to_traceroute_tables',
  settingsKey: 'migration_024_add_source_id_to_traceroute_tables',
  sqlite: (db) => addSourceIdToTracerouteTablesMigration.up(db),
  postgres: (client) => runMigration024Postgres(client),
  mysql: (pool) => runMigration024Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 025: Per-source auto time-sync scheduler (Phase 2c)
// Adds sourceId to auto_time_sync_nodes, replaces UNIQUE(nodeNum) with
// UNIQUE(nodeNum, sourceId).
// ---------------------------------------------------------------------------

registry.register({
  number: 25,
  name: 'add_source_id_to_time_sync_nodes',
  settingsKey: 'migration_025_add_source_id_to_time_sync_nodes',
  sqlite: (db) => addSourceIdToTimeSyncNodesMigration.up(db),
  postgres: (client) => runMigration025Postgres(client),
  mysql: (pool) => runMigration025Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 026: Per-source auto-delete-by-distance log (Phase 2d)
// Adds nullable sourceId to auto_distance_delete_log so each source's
// run-now history is scoped independently.
// ---------------------------------------------------------------------------

registry.register({
  number: 26,
  name: 'add_source_id_to_distance_delete_log',
  settingsKey: 'migration_026_add_source_id_to_distance_delete_log',
  sqlite: (db) => addSourceIdToDistanceDeleteLogMigration.up(db),
  postgres: (client) => runMigration026Postgres(client),
  mysql: (pool) => runMigration026Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 027: Per-source auto-key-repair log (Phase 2e)
// Adds nullable sourceId to auto_key_repair_log so each source's key-repair
// attempts are tracked independently.
// ---------------------------------------------------------------------------

registry.register({
  number: 27,
  name: 'add_source_id_to_key_repair_log',
  settingsKey: 'migration_027_add_source_id_to_key_repair_log',
  sqlite: (db) => addSourceIdToKeyRepairLogMigration.up(db),
  postgres: (client) => runMigration027Postgres(client),
  mysql: (pool) => runMigration027Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 028: Per-source notifications (Phase A)
// Adds sourceId to push_subscriptions and user_notification_preferences,
// deletes legacy NULL-sourceId rows, and replaces old unique constraints
// with composite uniques that include sourceId.
// ---------------------------------------------------------------------------

registry.register({
  number: 28,
  name: 'add_source_id_to_notifications',
  settingsKey: 'migration_028_add_source_id_to_notifications',
  sqlite: (db) => addSourceIdToNotificationsMigration.up(db),
  postgres: (client) => runMigration028Postgres(client),
  mysql: (pool) => runMigration028Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 029: Nodes composite PK (nodeNum, sourceId) — Phase 1 of nodes
// per-source refactor. Backfills NULL sourceIds to the first registered source
// and rebuilds the PK + unique constraints to be source-scoped.
// ---------------------------------------------------------------------------

registry.register({
  number: 29,
  name: 'nodes_composite_pk',
  settingsKey: 'migration_029_nodes_composite_pk',
  sqlite: (db) => nodesCompositePkMigration.up(db),
  postgres: (client) => runMigration029Postgres(client),
  mysql: (pool) => runMigration029Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 030: Add sourceId to route_segments and rebuild from traceroutes.
// route_segments previously had no sourceId column — this migration adds it,
// clears the table, and replays every traceroute to regenerate segment rows
// with the correct per-source attribution using each traceroute's stored
// routePositions snapshot.
// ---------------------------------------------------------------------------

registry.register({
  number: 30,
  name: 'add_source_id_to_route_segments',
  settingsKey: 'migration_030_add_source_id_to_route_segments',
  sqlite: (db) => addSourceIdToRouteSegmentsMigration.up(db),
  postgres: (client) => runMigration030Postgres(client),
  mysql: (pool) => runMigration030Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 031: Drop legacy standalone UNIQUE on nodes.nodeId.
// Migration 029's Postgres path used an ILIKE pattern against
// pg_get_constraintdef that failed to match the quoted column name, so the
// old constraint survived on upgraded databases and blocked cross-source node
// upserts. This migration drops it explicitly using pg_attribute.
// ---------------------------------------------------------------------------

registry.register({
  number: 31,
  name: 'drop_legacy_nodes_unique',
  settingsKey: 'migration_031_drop_legacy_nodes_unique',
  sqlite: (db) => dropLegacyNodesUniqueMigration.up(db),
  postgres: (client) => runMigration031Postgres(client),
  mysql: (pool) => runMigration031Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 032: Telemetry packet dedupe via soft unique constraint.
// Adds a partial unique index on (sourceId, nodeNum, packetId, telemetryType)
// so duplicate packets (e.g. re-broadcast through multiple mesh routers) are
// silently dropped at insert time instead of producing duplicate rows.
// See https://github.com/Yeraze/meshmonitor/issues/2629
// ---------------------------------------------------------------------------

registry.register({
  number: 32,
  name: 'telemetry_packet_dedupe',
  settingsKey: 'migration_032_telemetry_packet_dedupe',
  sqlite: (db) => telemetryPacketDedupeMigration.up(db),
  postgres: (client) => runMigration032Postgres(client),
  mysql: (pool) => runMigration032Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 033: Per-source permissions expansion + unique index.
// Expands existing global grants for sourcey resources into one row per source,
// drops the old unique constraint on (user_id, resource), creates a new unique
// index on (user_id, resource, sourceId), and migrates orphaned channel_database
// rows to the default source.
// ---------------------------------------------------------------------------

registry.register({
  number: 33,
  name: 'per_source_permissions',
  settingsKey: 'migration_033_per_source_permissions',
  sqlite: (db) => perSourcePermissionsMigration.up(db),
  postgres: (client) => runMigration033Postgres(client),
  mysql: (pool) => runMigration033Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 034: Add viaStoreForward column to messages table.
// Boolean flag to indicate messages received via Store & Forward replay,
// following the same pattern as the existing viaMqtt column.
// ---------------------------------------------------------------------------

registry.register({
  number: 34,
  name: 'add_via_store_forward',
  settingsKey: 'migration_034_add_via_store_forward',
  sqlite: (db) => addViaStoreForwardMigration.up(db),
  postgres: (client) => runMigration034Postgres(client),
  mysql: (pool) => runMigration034Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 035: Add isStoreForwardServer column to nodes table.
// Boolean flag to track nodes detected as Store & Forward servers via
// ROUTER_HEARTBEAT packets on PortNum 65.
// ---------------------------------------------------------------------------

registry.register({
  number: 35,
  name: 'add_is_store_forward_server',
  settingsKey: 'migration_035_add_is_store_forward_server',
  sqlite: (db) => addIsStoreForwardServerMigration.up(db),
  postgres: (client) => runMigration035Postgres(client),
  mysql: (pool) => runMigration035Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 036: Add compound indexes to telemetry table.
// PG/MySQL only had single-column indexes on nodeNum and timestamp. With 450k+
// rows, queries degrade to full table scans. Adds (nodeId, telemetryType,
// timestamp DESC) and (nodeNum, timestamp DESC) compound indexes.
// ---------------------------------------------------------------------------

registry.register({
  number: 36,
  name: 'telemetry_performance_indexes',
  settingsKey: 'migration_036_telemetry_performance_indexes',
  sqlite: (db) => telemetryPerformanceIndexesMigration.up(db),
  postgres: (client) => runMigration036Postgres(client),
  mysql: (pool) => runMigration036Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 037: Backfill missing user_map_preferences columns on PG/MySQL.
// Pre-baseline (v3.7) deployments lacked `id`, `createdAt`, and `updatedAt`.
// Drizzle's getMapPreferences (PR #2681) selects all schema columns, so PG
// fails with `column "id" does not exist` on those legacy tables.
// SQLite is unaffected (bootstrap creates the table with the right schema).
// ---------------------------------------------------------------------------

registry.register({
  number: 37,
  name: 'add_id_to_user_map_preferences',
  settingsKey: 'migration_037_add_id_to_user_map_preferences',
  sqlite: (db) => userMapPrefsIdMigration.up(db),
  postgres: (client) => runMigration037Postgres(client),
  mysql: (pool) => runMigration037Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 038: Delete orphan source-scoped notification rows.
// Source deletes don't cascade to user_notification_preferences /
// push_subscriptions, leaving dangling rows that cause duplicate-notification
// fan-out (one extra notification per orphan row per broadcast).
// ---------------------------------------------------------------------------

registry.register({
  number: 38,
  name: 'cleanup_orphan_notification_prefs',
  settingsKey: 'migration_038_cleanup_orphan_notification_prefs',
  sqlite: (db) => cleanupOrphanNotificationPrefsMigration.up(db),
  postgres: (client) => runMigration038Postgres(client),
  mysql: (pool) => runMigration038Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 039: Purge telemetry rows with NULL sourceId.
// Pre-beta4 write path never forwarded sourceId into telemetry inserts, so
// every row since the sourceId column was added (021) was stranded — strict
// source-scoped filtering made them invisible to TelemetryGraphs. Write path
// is fixed; this discards the unreachable rows.
// ---------------------------------------------------------------------------

registry.register({
  number: 39,
  name: 'purge_null_sourceid_telemetry',
  settingsKey: 'migration_039_purge_null_sourceid_telemetry',
  sqlite: (db) => purgeNullSourceIdTelemetryMigration.up(db),
  postgres: (client) => runMigration039Postgres(client),
  mysql: (pool) => runMigration039Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 040: Purge neighbor_info rows with NULL sourceId.
// Pre-fix, handleNeighborInfoApp didn't forward this.sourceId — the delete
// wiped cross-source data and the insert wrote NULL-sourced rows invisible
// to source-scoped reads. Write path is fixed; this discards stranded rows.
// ---------------------------------------------------------------------------

registry.register({
  number: 40,
  name: 'purge_null_sourceid_neighbor_info',
  settingsKey: 'migration_040_purge_null_sourceid_neighbor_info',
  sqlite: (db) => purgeNullSourceIdNeighborInfoMigration.up(db),
  postgres: (client) => runMigration040Postgres(client),
  mysql: (pool) => runMigration040Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 041: Drop legacy telemetry→nodes(nodeNum) FK on SQLite.
// Legacy v3.x databases carry a FK `telemetry.nodeNum REFERENCES
// nodes(nodeNum)` that became structurally invalid once 029 swapped nodes to
// a composite PK. Every DML on telemetry raises
// `foreign key mismatch - "telemetry" referencing "nodes"` with FKs enabled.
// This migration rebuilds the SQLite telemetry table without the FK so
// future migrations don't have to toggle foreign_keys=OFF. PG/MySQL baselines
// never declared this FK; no-op there.
// ---------------------------------------------------------------------------

registry.register({
  number: 41,
  name: 'drop_legacy_telemetry_nodes_fk',
  settingsKey: 'migration_041_drop_legacy_telemetry_nodes_fk',
  sqlite: (db) => dropLegacyTelemetryFkMigration.up(db),
  postgres: (client) => runMigration041Postgres(client),
  mysql: (pool) => runMigration041Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migrations 042-044: Drop remaining legacy child-table FKs to nodes(nodeNum).
// Same shape as 041: legacy Drizzle-push databases declared FKs on messages,
// neighbor_info, and traceroutes pointing at nodes(nodeNum), which became
// structurally invalid once 029 moved nodes to a composite PK. Rebuilding
// these tables once drops the broken FKs permanently so future DML migrations
// don't have to toggle foreign_keys=OFF. PG/MySQL baselines never declared
// these FKs; no-op there.
// ---------------------------------------------------------------------------

registry.register({
  number: 42,
  name: 'drop_legacy_messages_nodes_fk',
  settingsKey: 'migration_042_drop_legacy_messages_nodes_fk',
  sqlite: (db) => dropLegacyMessagesFkMigration.up(db),
  postgres: (client) => runMigration042Postgres(client),
  mysql: (pool) => runMigration042Mysql(pool),
});

registry.register({
  number: 43,
  name: 'drop_legacy_neighbor_info_nodes_fk',
  settingsKey: 'migration_043_drop_legacy_neighbor_info_nodes_fk',
  sqlite: (db) => dropLegacyNeighborInfoFkMigration.up(db),
  postgres: (client) => runMigration043Postgres(client),
  mysql: (pool) => runMigration043Mysql(pool),
});

registry.register({
  number: 44,
  name: 'drop_legacy_traceroutes_nodes_fk',
  settingsKey: 'migration_044_drop_legacy_traceroutes_nodes_fk',
  sqlite: (db) => dropLegacyTraceroutesFkMigration.up(db),
  postgres: (client) => runMigration044Postgres(client),
  mysql: (pool) => runMigration044Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 045: Drop legacy route_segments→nodes(nodeNum) FK on SQLite.
// Same shape as 041-044: legacy Drizzle-push databases declared a FK on
// route_segments pointing at nodes(nodeNum), which became structurally
// invalid once 029 moved nodes to a composite PK. Migration 030 had to
// toggle foreign_keys=OFF to work around this; since then the broken FK
// has caused every DELETE on route_segments (node purge, auto-delete, and
// maintenance cleanup) to fail with "foreign key mismatch". This rebuild
// drops the FK permanently. PG/MySQL baselines never declared it; no-op.
// ---------------------------------------------------------------------------

registry.register({
  number: 45,
  name: 'drop_legacy_route_segments_nodes_fk',
  settingsKey: 'migration_045_drop_legacy_route_segments_nodes_fk',
  sqlite: (db) => dropLegacyRouteSegmentsFkMigration.up(db),
  postgres: (client) => runMigration045Postgres(client),
  mysql: (pool) => runMigration045Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 046: Add missing id/createdAt/updatedAt to SQLite
// user_map_preferences. Migration 037 added these columns on PG/MySQL but
// its SQLite branch is a no-op because it assumes the bootstrap
// `CREATE TABLE IF NOT EXISTS` block creates `id`. That block never updates
// pre-existing legacy tables, so Drizzle's `.select()` in getMapPreferences
// fails with `no such column: "id"`. This rebuilds the table to match the
// current schema. PG/MySQL already covered by 037; no-op there.
// ---------------------------------------------------------------------------

registry.register({
  number: 46,
  name: 'add_user_map_preferences_id_sqlite',
  settingsKey: 'migration_046_add_user_map_preferences_id_sqlite',
  sqlite: (db) => addUserMapPrefsIdSqliteMigration.up(db),
  postgres: (client) => runMigration046Postgres(client),
  mysql: (pool) => runMigration046Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 047: Add `selectedLayer` column to user_map_preferences on
// PostgreSQL/MySQL. Pre-baseline (v3.6) deployments created the table with
// `selectedNodeNum` instead; `CREATE TABLE IF NOT EXISTS` in baseline 001 is
// a no-op on legacy tables, and migration 007 missed this column. Drizzle's
// getMapPreferences selects every schema column and fails with
// `column "selectedLayer" does not exist`. SQLite unaffected (bootstrap +
// migration 046 ensure the column).
// ---------------------------------------------------------------------------

registry.register({
  number: 47,
  name: 'add_selected_layer_to_user_map_preferences',
  settingsKey: 'migration_047_add_selected_layer_to_user_map_preferences',
  sqlite: (db) => addSelectedLayerMigration.up(db),
  postgres: (client) => runMigration047Postgres(client),
  mysql: (pool) => runMigration047Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 048: Rebuild ignored_nodes as per-source ((nodeNum, sourceId) PK
// with FK to sources ON DELETE CASCADE). Drops the legacy global table and
// backfills from nodes.isIgnored=1 so each source owns its own blocklist.
// ---------------------------------------------------------------------------

registry.register({
  number: 48,
  name: 'rebuild_ignored_nodes_per_source',
  settingsKey: 'migration_048_rebuild_ignored_nodes_per_source',
  sqlite: (db) => rebuildIgnoredNodesPerSourceMigration.up(db),
  postgres: (client) => runMigration048Postgres(client),
  mysql: (pool) => runMigration048Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 049: Composite indexes for hot query patterns (issue #2831)
// telemetry (telemetryType, nodeId, timestamp DESC), telemetry (sourceId,
// nodeId, telemetryType), messages (sourceId, timestamp DESC),
// neighbor_info (sourceId, nodeNum).
// ---------------------------------------------------------------------------

registry.register({
  number: 49,
  name: 'perf_composite_indexes',
  settingsKey: 'migration_049_perf_composite_indexes',
  sqlite: (db) => perfCompositeIndexesMigration.up(db),
  postgres: (client) => runMigration049Postgres(client),
  mysql: (pool) => runMigration049Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 050: Promote legacy global per-source settings (and orphan
// NULL-sourceId rows in auto_traceroute_nodes / auto_time_sync_nodes) to the
// default source's namespace, so single-source pre-4.x users don't lose
// configuration after the global-fallback in getSettingForSource is removed.
// ---------------------------------------------------------------------------

registry.register({
  number: 50,
  name: 'promote_globals_to_default_source',
  settingsKey: 'migration_050_promote_globals_to_default_source',
  sqlite: (db) => promoteGlobalsToDefaultSourceMigration.up(db),
  postgres: (client) => runMigration050Postgres(client),
  mysql: (pool) => runMigration050Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 051: Drop legacy single-column UNIQUE on
// user_notification_preferences.userId. Migration 028 only dropped one of the
// two possible constraint names; PostgreSQL deployments where the constraint
// was originally auto-named with a `_key` suffix still block per-source
// notification preference upserts. Defensive across PG/MySQL/SQLite.
// ---------------------------------------------------------------------------

registry.register({
  number: 51,
  name: 'drop_legacy_notif_prefs_userid_unique',
  settingsKey: 'migration_051_drop_legacy_notif_prefs_userid_unique',
  sqlite: (db) => dropLegacyNotifPrefsUserIdUniqueMigration.up(db),
  postgres: (client) => runMigration051Postgres(client),
  mysql: (pool) => runMigration051Mysql(pool),
});
