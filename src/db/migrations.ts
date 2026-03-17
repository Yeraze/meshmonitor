/**
 * Migration Registry Barrel File
 *
 * Registers all 87 migrations in sequential order for use by the migration runner.
 * Migration 001 is selfIdempotent (uses CREATE TABLE IF NOT EXISTS).
 * Migrations 002-046 use settingsKey guards — they are NOT truly idempotent
 * (permissions rebuild migrations use CREATE TABLE _new / SELECT * / DROP / RENAME
 * which fails if re-run on a DB with more columns than expected).
 * New-style migrations (047+) also use settingsKey for SQLite idempotency tracking.
 *
 * Note: Some migrations (026, 027, 029, 031) exist as files but were never wired
 * into database.ts. They are registered here with settingsKey guards like all
 * other non-idempotent migrations, to maintain sequential numbering.
 */

import { MigrationRegistry } from './migrationRegistry.js';

// === Old-style migrations (001-046) — export { migration } with .up(db) ===
import { migration as authMigration } from '../server/migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../server/migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../server/migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../server/migrations/004_add_traceroute_permission.js';
import { migration as auditLogMigration } from '../server/migrations/005_enhance_audit_log.js';
import { migration as auditPermissionMigration } from '../server/migrations/006_add_audit_permission.js';
import { migration as readMessagesMigration } from '../server/migrations/007_add_read_messages.js';
import { migration as pushSubscriptionsMigration } from '../server/migrations/008_add_push_subscriptions.js';
import { migration as notificationPreferencesMigration } from '../server/migrations/009_add_notification_preferences.js';
import { migration as notifyOnEmojiMigration } from '../server/migrations/010_add_notify_on_emoji.js';
import { migration as packetLogMigration } from '../server/migrations/011_add_packet_log.js';
import { migration as channelRoleMigration } from '../server/migrations/012_add_channel_role_and_position.js';
import { migration as backupTablesMigration } from '../server/migrations/013_add_backup_tables.js';
import { migration as messageDeliveryTrackingMigration } from '../server/migrations/014_add_message_delivery_tracking.js';
import { migration as autoTracerouteFilterMigration } from '../server/migrations/015_add_auto_traceroute_filter.js';
import { migration as securityPermissionMigration } from '../server/migrations/016_add_security_permission.js';
import { migration as channelColumnMigration } from '../server/migrations/017_add_channel_to_nodes.js';
import { migration as mobileMigration } from '../server/migrations/018_add_mobile_to_nodes.js';
import { migration as solarEstimatesMigration } from '../server/migrations/019_add_solar_estimates.js';
import { migration as positionPrecisionMigration } from '../server/migrations/020_add_position_precision_tracking.js';
import { migration as systemBackupTableMigration } from '../server/migrations/021_add_system_backup_table.js';
import { migration as customThemesMigration } from '../server/migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../server/migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../server/migrations/024_add_per_channel_permissions.js';
import { migration as apiTokensMigration } from '../server/migrations/025_add_api_tokens.js';
import { migration as relayNodeMessagesMigration } from '../server/migrations/026_add_relay_node_to_messages.js';
import { migration as ackFromNodeMessagesMigration } from '../server/migrations/027_add_ack_from_node_to_messages.js';
import { migration as cascadeForeignKeysMigration } from '../server/migrations/028_add_cascade_to_foreign_keys.js';
import { migration as autoAckDirectMigration } from '../server/migrations/029_add_auto_ack_direct_message.js';
import { migration as userMapPreferencesMigration } from '../server/migrations/030_add_user_map_preferences.js';
import { migration as sortingPreferencesMigration } from '../server/migrations/031_add_sorting_to_user_preferences.js';
import { migration as inactiveNodeNotificationMigration } from '../server/migrations/032_add_notify_on_inactive_node.js';
import { migration as isIgnoredMigration } from '../server/migrations/033_add_is_ignored_to_nodes.js';
import { migration as notifyOnServerEventsMigration } from '../server/migrations/034_add_notify_on_server_events.js';
import { migration as prefixWithNodeNameMigration } from '../server/migrations/035_add_prefix_with_node_name.js';
import { migration as perUserAppriseUrlsMigration } from '../server/migrations/036_add_per_user_apprise_urls.js';
import { migration as notifyOnMqttMigration } from '../server/migrations/037_add_notify_on_mqtt.js';
import { migration as recalculateEstimatedPositionsMigration } from '../server/migrations/038_recalculate_estimated_positions.js';
import { migration as recalculateEstimatedPositionsFixMigration } from '../server/migrations/039_recalculate_estimated_positions_fix.js';
import { migration as positionOverrideMigration } from '../server/migrations/040_add_position_override_to_nodes.js';
import { migration as autoTracerouteLogMigration } from '../server/migrations/041_add_auto_traceroute_log.js';
import { migration as relayNodePacketLogMigration } from '../server/migrations/042_add_relay_node_to_packet_log.js';
import { migration as positionOverridePrivacyMigration } from '../server/migrations/043_add_position_override_privacy.js';
import { migration as nodesPrivatePermissionMigration } from '../server/migrations/044_add_nodes_private_permission.js';
import { migration as packetDirectionMigration } from '../server/migrations/045_add_packet_direction.js';
import { migration as autoKeyRepairMigration } from '../server/migrations/046_add_auto_key_repair.js';

// === New-style migrations (047+) — have runMigrationNNNPostgres/Mysql functions ===
import { migration as positionOverrideBooleanMigration, runMigration047Postgres, runMigration047Mysql } from '../server/migrations/047_fix_position_override_boolean_types.js';
import { migration as autoTracerouteColumnMigration } from '../server/migrations/048_fix_auto_traceroute_column_name.js';
import { migration as notificationChannelSettingsMigration, runMigration049Postgres, runMigration049Mysql } from '../server/migrations/049_add_notification_channel_settings.js';
import { migration as channelDatabaseMigration, runMigration050Postgres, runMigration050Mysql } from '../server/migrations/050_add_channel_database.js';
import { migration as decryptedByMessagesMigration, runMigration051Postgres, runMigration051Mysql } from '../server/migrations/051_add_decrypted_by_to_messages.js';
import { migration as upgradeHistorySchemaMigration, runMigration052Postgres, runMigration052Mysql } from '../server/migrations/052_fix_upgrade_history_schema.js';
import { migration as viewOnMapPermissionMigration, runMigration053Postgres, runMigration053Mysql } from '../server/migrations/053_add_view_on_map_permission.js';
import { migration as newsTablesMigration, runMigration054Postgres, runMigration054Mysql } from '../server/migrations/054_add_news_tables.js';
import { migration as remoteAdminColumnsMigration, runMigration055Postgres, runMigration055Mysql } from '../server/migrations/055_add_remote_admin_columns.js';
import { migration as backupHistoryColumnsMigration, runMigration056Postgres, runMigration056Mysql } from '../server/migrations/056_fix_backup_history_columns.js';
import { migration as packetViaMqttMigration, runMigration057Postgres, runMigration057Mysql } from '../server/migrations/057_add_packet_via_mqtt.js';
import { migration as transportMechanismMigration, runMigration058Postgres, runMigration058Mysql } from '../server/migrations/058_convert_via_mqtt_to_transport_mechanism.js';
import { migration as channelDbViewOnMapMigration, runMigration059Postgres, runMigration059Mysql } from '../server/migrations/059_add_channel_database_view_on_map.js';
import { migration as autoTracerouteEnabledMigration, runMigration060Postgres, runMigration060Mysql } from '../server/migrations/060_add_auto_traceroute_enabled_column.js';
import { migration as spamDetectionMigration, runMigration061Postgres, runMigration061Mysql } from '../server/migrations/061_add_spam_detection_columns.js';
import { migration as positionDoublePrecisionMigration, runMigration062Postgres, runMigration062Mysql } from '../server/migrations/062_upgrade_position_precision.js';
import { migration as positionHistoryHoursMigration, runMigration063Postgres, runMigration063Mysql } from '../server/migrations/063_add_position_history_hours.js';
import { migration as enforceNameValidationMigration, runMigration064Postgres, runMigration064Mysql } from '../server/migrations/064_add_enforce_name_validation.js';
import { migration as sortOrderMigration, runMigration065Postgres, runMigration065Mysql } from '../server/migrations/065_add_sortorder_to_channel_database.js';
import { migration as ignoredNodesMigration, runMigration066Postgres, runMigration066Mysql } from '../server/migrations/066_add_ignored_nodes_table.js';
import { migration as autoTimeSyncMigration, runMigration067Postgres, runMigration067Mysql } from '../server/migrations/067_add_auto_time_sync.js';
import { migration as mfaColumnsMigration, runMigration068Postgres, runMigration068Mysql } from '../server/migrations/068_add_mfa_columns.js';
import { migration as traceroutePositionsMigration, runMigration069Postgres, runMigration069Mysql } from '../server/migrations/069_add_traceroute_positions.js';
import { migration as meshcoreTablesMigration, runMigration070Postgres as runMigration070MeshcorePostgres, runMigration070Mysql as runMigration070MeshcoreMysql } from '../server/migrations/070_add_meshcore_tables.js';
import { migration as meshcorePermissionMigration, runMigration071Postgres, runMigration071Mysql } from '../server/migrations/071_add_meshcore_permission.js';
import { migration as dmUnreadIndexMigration, runMigration072Postgres, runMigration072Mysql } from '../server/migrations/072_add_messages_dm_unread_index.js';
import { migration as packetIdMigration, runMigration073Postgres, runMigration073Mysql } from '../server/migrations/073_add_packet_id_to_telemetry.js';
import { migration as showMeshCoreNodesMigration, runMigration074Postgres, runMigration074Mysql } from '../server/migrations/074_add_show_meshcore_nodes_preference.js';
import { migration as telemetryPacketIdBigintMigration, runMigration075Postgres, runMigration075Mysql } from '../server/migrations/075_upgrade_telemetry_packetid_bigint.js';
import { migration as accuracyEstimatedPrefsMigration, runMigration076Postgres, runMigration076Mysql } from '../server/migrations/076_add_accuracy_and_estimated_position_prefs.js';
import { migration as ignoredNodesNodeNumBigintMigration, runMigration077Postgres, runMigration077Mysql } from '../server/migrations/077_upgrade_ignored_nodes_nodenum_bigint.js';
import { migration as createEmbedProfilesMigration, runMigration078Postgres, runMigration078Mysql } from '../server/migrations/078_create_embed_profiles.js';
import { migration as createGeofenceCooldownsMigration, runMigration079Postgres, runMigration079Mysql } from '../server/migrations/079_create_geofence_cooldowns.js';
import { migration as addFavoriteLockedMigration, runMigration080Postgres, runMigration080Mysql } from '../server/migrations/080_add_favorite_locked.js';
import { migration as addTimeOffsetColumnsMigration, runMigration081Postgres, runMigration081Mysql } from '../server/migrations/081_add_time_offset_columns.js';
import { migration as addPacketmonitorPermissionMigration, runMigration082Postgres, runMigration082Mysql } from '../server/migrations/082_add_packetmonitor_permission.js';
import { runMigration083Sqlite, runMigration083Postgres, runMigration083Mysql } from '../server/migrations/083_add_missing_map_preference_columns.js';
import { runMigration084Sqlite, runMigration084Postgres, runMigration084Mysql } from '../server/migrations/084_add_key_mismatch_columns.js';
import { migration as fixCustomThemesColumnsMigration, runMigration085Postgres, runMigration085Mysql } from '../server/migrations/085_fix_custom_themes_columns.js';
import { runMigration086Sqlite, runMigration086Postgres, runMigration086Mysql } from '../server/migrations/086_add_auto_distance_delete_log.js';
import { migration as fixMessageNodeNumBigintMigration, runMigration087Postgres, runMigration087Mysql } from '../server/migrations/087_fix_message_nodenum_bigint.js';

// ============================================================================
// Registry
// ============================================================================

export const registry = new MigrationRegistry();

// ---------------------------------------------------------------------------
// Old-style migrations (001-046)
// Migration 001 is truly selfIdempotent (uses CREATE TABLE IF NOT EXISTS).
// Migrations 002-046 need settingsKey guards — many do table rebuilds with
// CREATE TABLE _new / SELECT * / DROP / RENAME that fail if re-run.
// Only SQLite functions are registered (Postgres/MySQL use base schema SQL).
// ---------------------------------------------------------------------------

registry.register({
  number: 1,
  name: 'add_auth_tables',
  selfIdempotent: true,
  sqlite: (db) => authMigration.up(db),
});

registry.register({
  number: 2,
  name: 'add_channels_permission',
  settingsKey: 'migration_002_channels_permission',
  sqlite: (db) => channelsMigration.up(db),
});

registry.register({
  number: 3,
  name: 'add_connection_permission',
  settingsKey: 'migration_003_connection_permission',
  sqlite: (db) => connectionMigration.up(db),
});

registry.register({
  number: 4,
  name: 'add_traceroute_permission',
  settingsKey: 'migration_004_traceroute_permission',
  sqlite: (db) => tracerouteMigration.up(db),
});

registry.register({
  number: 5,
  name: 'enhance_audit_log',
  settingsKey: 'migration_005_enhance_audit_log',
  sqlite: (db) => auditLogMigration.up(db),
});

registry.register({
  number: 6,
  name: 'add_audit_permission',
  settingsKey: 'migration_006_audit_permission',
  sqlite: (db) => auditPermissionMigration.up(db),
});

registry.register({
  number: 7,
  name: 'add_read_messages',
  settingsKey: 'migration_007_read_messages',
  sqlite: (db) => readMessagesMigration.up(db),
});

registry.register({
  number: 8,
  name: 'add_push_subscriptions',
  settingsKey: 'migration_008_push_subscriptions',
  sqlite: (db) => pushSubscriptionsMigration.up(db),
});

registry.register({
  number: 9,
  name: 'add_notification_preferences',
  settingsKey: 'migration_009_notification_preferences',
  sqlite: (db) => notificationPreferencesMigration.up(db),
});

registry.register({
  number: 10,
  name: 'add_notify_on_emoji',
  settingsKey: 'migration_010_notify_on_emoji',
  sqlite: (db) => notifyOnEmojiMigration.up(db),
});

registry.register({
  number: 11,
  name: 'add_packet_log',
  settingsKey: 'migration_011_packet_log',
  sqlite: (db) => packetLogMigration.up(db),
});

registry.register({
  number: 12,
  name: 'add_channel_role_and_position',
  settingsKey: 'migration_012_channel_role',
  sqlite: (db) => channelRoleMigration.up(db),
});

registry.register({
  number: 13,
  name: 'add_backup_tables',
  settingsKey: 'migration_013_add_backup_tables',
  sqlite: (db) => backupTablesMigration.up(db),
});

registry.register({
  number: 14,
  name: 'add_message_delivery_tracking',
  settingsKey: 'migration_014_message_delivery_tracking',
  sqlite: (db) => messageDeliveryTrackingMigration.up(db),
});

registry.register({
  number: 15,
  name: 'add_auto_traceroute_filter',
  settingsKey: 'migration_015_auto_traceroute_filter',
  sqlite: (db) => autoTracerouteFilterMigration.up(db),
});

registry.register({
  number: 16,
  name: 'add_security_permission',
  settingsKey: 'migration_016_security_permission',
  sqlite: (db) => securityPermissionMigration.up(db),
});

registry.register({
  number: 17,
  name: 'add_channel_to_nodes',
  settingsKey: 'migration_017_add_channel_to_nodes',
  sqlite: (db) => channelColumnMigration.up(db),
});

registry.register({
  number: 18,
  name: 'add_mobile_to_nodes',
  settingsKey: 'migration_018_add_mobile_to_nodes',
  sqlite: (db) => mobileMigration.up(db),
});

registry.register({
  number: 19,
  name: 'add_solar_estimates',
  settingsKey: 'migration_019_solar_estimates',
  sqlite: (db) => solarEstimatesMigration.up(db),
});

registry.register({
  number: 20,
  name: 'add_position_precision_tracking',
  settingsKey: 'migration_020_position_precision',
  sqlite: (db) => positionPrecisionMigration.up(db),
});

registry.register({
  number: 21,
  name: 'add_system_backup_table',
  settingsKey: 'migration_021_system_backup_table',
  sqlite: (db) => systemBackupTableMigration.up(db),
});

registry.register({
  number: 22,
  name: 'add_custom_themes',
  settingsKey: 'migration_022_custom_themes',
  sqlite: (db) => customThemesMigration.up(db),
});

registry.register({
  number: 23,
  name: 'add_password_locked_flag',
  settingsKey: 'migration_023_password_locked',
  sqlite: (db) => passwordLockedMigration.up(db),
});

registry.register({
  number: 24,
  name: 'add_per_channel_permissions',
  settingsKey: 'migration_024_per_channel_permissions',
  sqlite: (db) => perChannelPermissionsMigration.up(db),
});

registry.register({
  number: 25,
  name: 'add_api_tokens',
  settingsKey: 'migration_025_api_tokens',
  sqlite: (db) => apiTokensMigration.up(db),
});

// Migrations 026, 027 exist as files but were never wired into database.ts.
// They use bare ALTER TABLE ADD COLUMN (no IF NOT EXISTS check), so they need settingsKey guards.
registry.register({
  number: 26,
  name: 'add_relay_node_to_messages',
  settingsKey: 'migration_026_relay_node_messages',
  sqlite: (db) => relayNodeMessagesMigration.up(db),
});

registry.register({
  number: 27,
  name: 'add_ack_from_node_to_messages',
  settingsKey: 'migration_027_ack_from_node_messages',
  sqlite: (db) => ackFromNodeMessagesMigration.up(db),
});

registry.register({
  number: 28,
  name: 'add_cascade_to_foreign_keys',
  settingsKey: 'migration_028_cascade_foreign_keys',
  sqlite: (db) => cascadeForeignKeysMigration.up(db),
});

// Migration 029 exists as file but was never wired into database.ts.
// Uses INSERT OR IGNORE but the settings table requires NOT NULL on createdAt/updatedAt,
// so the INSERT would fail. Use settingsKey guard instead.
registry.register({
  number: 29,
  name: 'add_auto_ack_direct_message',
  settingsKey: 'migration_029_auto_ack_direct',
  sqlite: (db) => autoAckDirectMigration.up(db),
});

registry.register({
  number: 30,
  name: 'add_user_map_preferences',
  settingsKey: 'migration_030_user_map_preferences',
  sqlite: (db) => userMapPreferencesMigration.up(db),
});

// Migration 031 exists as file but was never wired into database.ts.
// Uses bare ALTER TABLE ADD COLUMN (no IF NOT EXISTS check), so it needs a settingsKey guard.
registry.register({
  number: 31,
  name: 'add_sorting_to_user_preferences',
  settingsKey: 'migration_031_sorting_preferences',
  sqlite: (db) => sortingPreferencesMigration.up(db),
});

registry.register({
  number: 32,
  name: 'add_notify_on_inactive_node',
  settingsKey: 'migration_032_inactive_node_notification',
  sqlite: (db) => inactiveNodeNotificationMigration.up(db),
});

registry.register({
  number: 33,
  name: 'add_is_ignored_to_nodes',
  settingsKey: 'migration_033_is_ignored',
  sqlite: (db) => isIgnoredMigration.up(db),
});

registry.register({
  number: 34,
  name: 'add_notify_on_server_events',
  settingsKey: 'migration_034_notify_on_server_events',
  sqlite: (db) => notifyOnServerEventsMigration.up(db),
});

registry.register({
  number: 35,
  name: 'add_prefix_with_node_name',
  settingsKey: 'migration_035_prefix_with_node_name',
  sqlite: (db) => prefixWithNodeNameMigration.up(db),
});

registry.register({
  number: 36,
  name: 'add_per_user_apprise_urls',
  settingsKey: 'migration_036_per_user_apprise_urls',
  sqlite: (db) => perUserAppriseUrlsMigration.up(db),
});

registry.register({
  number: 37,
  name: 'add_notify_on_mqtt',
  settingsKey: 'migration_037_notify_on_mqtt',
  sqlite: (db) => notifyOnMqttMigration.up(db),
});

registry.register({
  number: 38,
  name: 'recalculate_estimated_positions',
  settingsKey: 'migration_038_recalculate_estimated_positions',
  sqlite: (db) => recalculateEstimatedPositionsMigration.up(db),
});

registry.register({
  number: 39,
  name: 'recalculate_estimated_positions_fix',
  settingsKey: 'migration_039_recalculate_estimated_positions_fix',
  sqlite: (db) => recalculateEstimatedPositionsFixMigration.up(db),
});

registry.register({
  number: 40,
  name: 'add_position_override_to_nodes',
  settingsKey: 'migration_040_position_override',
  sqlite: (db) => positionOverrideMigration.up(db),
});

registry.register({
  number: 41,
  name: 'add_auto_traceroute_log',
  settingsKey: 'migration_041_auto_traceroute_log',
  sqlite: (db) => autoTracerouteLogMigration.up(db),
});

registry.register({
  number: 42,
  name: 'add_relay_node_to_packet_log',
  settingsKey: 'migration_042_relay_node_packet_log',
  sqlite: (db) => relayNodePacketLogMigration.up(db),
});

registry.register({
  number: 43,
  name: 'add_position_override_privacy',
  settingsKey: 'migration_043_position_override_privacy',
  sqlite: (db) => positionOverridePrivacyMigration.up(db),
});

registry.register({
  number: 44,
  name: 'add_nodes_private_permission',
  settingsKey: 'migration_044_nodes_private_permission',
  sqlite: (db) => nodesPrivatePermissionMigration.up(db),
});

registry.register({
  number: 45,
  name: 'add_packet_direction',
  settingsKey: 'migration_045_packet_direction',
  sqlite: (db) => packetDirectionMigration.up(db),
});

registry.register({
  number: 46,
  name: 'add_auto_key_repair',
  settingsKey: 'migration_046_auto_key_repair',
  sqlite: (db) => autoKeyRepairMigration.up(db),
});

// ---------------------------------------------------------------------------
// New-style migrations (047+)
// These use settingsKey for SQLite idempotency and have separate Postgres/MySQL functions.
// ---------------------------------------------------------------------------

registry.register({
  number: 47,
  name: 'fix_position_override_boolean_types',
  settingsKey: 'migration_047_position_override_boolean',
  sqlite: (db) => positionOverrideBooleanMigration.up(db),
  postgres: (client) => runMigration047Postgres(client),
  mysql: (pool) => runMigration047Mysql(pool),
});

// Migration 048 is SQLite-only (fixes column name inconsistency from migration 015)
registry.register({
  number: 48,
  name: 'fix_auto_traceroute_column_name',
  settingsKey: 'migration_048_auto_traceroute_column',
  sqlite: (db) => autoTracerouteColumnMigration.up(db),
});

registry.register({
  number: 49,
  name: 'add_notification_channel_settings',
  settingsKey: 'migration_049_notification_channel_settings',
  sqlite: (db) => notificationChannelSettingsMigration.up(db),
  postgres: (client) => runMigration049Postgres(client),
  mysql: (pool) => runMigration049Mysql(pool),
});

registry.register({
  number: 50,
  name: 'add_channel_database',
  settingsKey: 'migration_050_channel_database',
  sqlite: (db) => channelDatabaseMigration.up(db),
  postgres: (client) => runMigration050Postgres(client),
  mysql: (pool) => runMigration050Mysql(pool),
});

registry.register({
  number: 51,
  name: 'add_decrypted_by_to_messages',
  settingsKey: 'migration_051_decrypted_by_messages',
  sqlite: (db) => decryptedByMessagesMigration.up(db),
  postgres: (client) => runMigration051Postgres(client),
  mysql: (pool) => runMigration051Mysql(pool),
});

registry.register({
  number: 52,
  name: 'fix_upgrade_history_schema',
  settingsKey: 'migration_052_upgrade_history_schema',
  sqlite: (db) => upgradeHistorySchemaMigration.up(db),
  postgres: (client) => runMigration052Postgres(client),
  mysql: (pool) => runMigration052Mysql(pool),
});

registry.register({
  number: 53,
  name: 'add_view_on_map_permission',
  settingsKey: 'migration_053_view_on_map_permission',
  sqlite: (db) => viewOnMapPermissionMigration.up(db),
  postgres: (client) => runMigration053Postgres(client),
  mysql: (pool) => runMigration053Mysql(pool),
});

registry.register({
  number: 54,
  name: 'add_news_tables',
  settingsKey: 'migration_054_news_tables',
  sqlite: (db) => newsTablesMigration.up(db),
  postgres: (client) => runMigration054Postgres(client),
  mysql: (pool) => runMigration054Mysql(pool),
});

registry.register({
  number: 55,
  name: 'add_remote_admin_columns',
  settingsKey: 'migration_055_remote_admin_columns',
  sqlite: (db) => remoteAdminColumnsMigration.up(db),
  postgres: (client) => runMigration055Postgres(client),
  mysql: (pool) => runMigration055Mysql(pool),
});

registry.register({
  number: 56,
  name: 'fix_backup_history_columns',
  settingsKey: 'migration_056_backup_history_columns',
  sqlite: (db) => backupHistoryColumnsMigration.up(db),
  postgres: (client) => runMigration056Postgres(client),
  mysql: (pool) => runMigration056Mysql(pool),
});

registry.register({
  number: 57,
  name: 'add_packet_via_mqtt',
  settingsKey: 'migration_057_packet_via_mqtt',
  sqlite: (db) => packetViaMqttMigration.up(db),
  postgres: (client) => runMigration057Postgres(client),
  mysql: (pool) => runMigration057Mysql(pool),
});

registry.register({
  number: 58,
  name: 'convert_via_mqtt_to_transport_mechanism',
  settingsKey: 'migration_058_transport_mechanism',
  sqlite: (db) => transportMechanismMigration.up(db),
  postgres: (client) => runMigration058Postgres(client),
  mysql: (pool) => runMigration058Mysql(pool),
});

registry.register({
  number: 59,
  name: 'add_channel_database_view_on_map',
  settingsKey: 'migration_059_channel_db_view_on_map',
  sqlite: (db) => channelDbViewOnMapMigration.up(db),
  postgres: (client) => runMigration059Postgres(client),
  mysql: (pool) => runMigration059Mysql(pool),
});

registry.register({
  number: 60,
  name: 'add_auto_traceroute_enabled_column',
  settingsKey: 'migration_060_auto_traceroute_enabled',
  sqlite: (db) => autoTracerouteEnabledMigration.up(db),
  postgres: (client) => runMigration060Postgres(client),
  mysql: (pool) => runMigration060Mysql(pool),
});

registry.register({
  number: 61,
  name: 'add_spam_detection_columns',
  settingsKey: 'migration_061_spam_detection',
  sqlite: (db) => spamDetectionMigration.up(db),
  postgres: (client) => runMigration061Postgres(client),
  mysql: (pool) => runMigration061Mysql(pool),
});

registry.register({
  number: 62,
  name: 'upgrade_position_precision',
  settingsKey: 'migration_062_position_double_precision',
  sqlite: (db) => positionDoublePrecisionMigration.up(db),
  postgres: (client) => runMigration062Postgres(client),
  mysql: (pool) => runMigration062Mysql(pool),
});

registry.register({
  number: 63,
  name: 'add_position_history_hours',
  settingsKey: 'migration_063_position_history_hours',
  sqlite: (db) => positionHistoryHoursMigration.up(db),
  postgres: (client) => runMigration063Postgres(client),
  mysql: (pool) => runMigration063Mysql(pool),
});

registry.register({
  number: 64,
  name: 'add_enforce_name_validation',
  settingsKey: 'migration_064_enforce_name_validation',
  sqlite: (db) => enforceNameValidationMigration.up(db),
  postgres: (client) => runMigration064Postgres(client),
  mysql: (pool) => runMigration064Mysql(pool),
});

registry.register({
  number: 65,
  name: 'add_sortorder_to_channel_database',
  settingsKey: 'migration_065_sortorder',
  sqlite: (db) => sortOrderMigration.up(db),
  postgres: (client) => runMigration065Postgres(client),
  mysql: (pool) => runMigration065Mysql(pool),
});

registry.register({
  number: 66,
  name: 'add_ignored_nodes_table',
  settingsKey: 'migration_066_ignored_nodes_table',
  sqlite: (db) => ignoredNodesMigration.up(db),
  postgres: (client) => runMigration066Postgres(client),
  mysql: (pool) => runMigration066Mysql(pool),
});

registry.register({
  number: 67,
  name: 'add_auto_time_sync',
  settingsKey: 'migration_067_auto_time_sync',
  sqlite: (db) => autoTimeSyncMigration.up(db),
  postgres: (client) => runMigration067Postgres(client),
  mysql: (pool) => runMigration067Mysql(pool),
});

registry.register({
  number: 68,
  name: 'add_mfa_columns',
  settingsKey: 'migration_068_mfa_columns',
  sqlite: (db) => mfaColumnsMigration.up(db),
  postgres: (client) => runMigration068Postgres(client),
  mysql: (pool) => runMigration068Mysql(pool),
});

registry.register({
  number: 69,
  name: 'add_traceroute_positions',
  settingsKey: 'migration_069_traceroute_positions',
  sqlite: (db) => traceroutePositionsMigration.up(db),
  postgres: (client) => runMigration069Postgres(client),
  mysql: (pool) => runMigration069Mysql(pool),
});

registry.register({
  number: 70,
  name: 'add_meshcore_tables',
  settingsKey: 'migration_070_meshcore_tables',
  sqlite: (db) => meshcoreTablesMigration.up(db),
  postgres: (client) => runMigration070MeshcorePostgres(client),
  mysql: (pool) => runMigration070MeshcoreMysql(pool),
});

registry.register({
  number: 71,
  name: 'add_meshcore_permission',
  settingsKey: 'migration_071_meshcore_permission',
  sqlite: (db) => meshcorePermissionMigration.up(db),
  postgres: (client) => runMigration071Postgres(client),
  mysql: (pool) => runMigration071Mysql(pool),
});

registry.register({
  number: 72,
  name: 'add_messages_dm_unread_index',
  settingsKey: 'migration_072_dm_unread_index',
  sqlite: (db) => dmUnreadIndexMigration.up(db),
  postgres: (client) => runMigration072Postgres(client),
  mysql: (pool) => runMigration072Mysql(pool),
});

registry.register({
  number: 73,
  name: 'add_packet_id_to_telemetry',
  settingsKey: 'migration_073_packet_id_telemetry',
  sqlite: (db) => packetIdMigration.up(db),
  postgres: (client) => runMigration073Postgres(client),
  mysql: (pool) => runMigration073Mysql(pool),
});

registry.register({
  number: 74,
  name: 'add_show_meshcore_nodes_preference',
  settingsKey: 'migration_074_show_meshcore_nodes',
  sqlite: (db) => showMeshCoreNodesMigration.up(db),
  postgres: (client) => runMigration074Postgres(client),
  mysql: (pool) => runMigration074Mysql(pool),
});

registry.register({
  number: 75,
  name: 'upgrade_telemetry_packetid_bigint',
  settingsKey: 'migration_075_telemetry_packetid_bigint',
  sqlite: (db) => telemetryPacketIdBigintMigration.up(db),
  postgres: (client) => runMigration075Postgres(client),
  mysql: (pool) => runMigration075Mysql(pool),
});

registry.register({
  number: 76,
  name: 'add_accuracy_and_estimated_position_prefs',
  settingsKey: 'migration_076_accuracy_estimated_prefs',
  sqlite: (db) => accuracyEstimatedPrefsMigration.up(db),
  postgres: (client) => runMigration076Postgres(client),
  mysql: (pool) => runMigration076Mysql(pool),
});

registry.register({
  number: 77,
  name: 'upgrade_ignored_nodes_nodenum_bigint',
  settingsKey: 'migration_077_ignored_nodes_nodenum_bigint',
  sqlite: (db) => ignoredNodesNodeNumBigintMigration.up(db),
  postgres: (client) => runMigration077Postgres(client),
  mysql: (pool) => runMigration077Mysql(pool),
});

registry.register({
  number: 78,
  name: 'create_embed_profiles',
  settingsKey: 'migration_078_create_embed_profiles',
  sqlite: (db) => createEmbedProfilesMigration.up(db),
  postgres: (client) => runMigration078Postgres(client),
  mysql: (pool) => runMigration078Mysql(pool),
});

registry.register({
  number: 79,
  name: 'create_geofence_cooldowns',
  settingsKey: 'migration_079_create_geofence_cooldowns',
  sqlite: (db) => createGeofenceCooldownsMigration.up(db),
  postgres: (client) => runMigration079Postgres(client),
  mysql: (pool) => runMigration079Mysql(pool),
});

registry.register({
  number: 80,
  name: 'add_favorite_locked',
  settingsKey: 'migration_080_add_favorite_locked',
  sqlite: (db) => addFavoriteLockedMigration.up(db),
  postgres: (client) => runMigration080Postgres(client),
  mysql: (pool) => runMigration080Mysql(pool),
});

registry.register({
  number: 81,
  name: 'add_time_offset_columns',
  settingsKey: 'migration_081_time_offset_columns',
  sqlite: (db) => addTimeOffsetColumnsMigration.up(db),
  postgres: (client) => runMigration081Postgres(client),
  mysql: (pool) => runMigration081Mysql(pool),
});

registry.register({
  number: 82,
  name: 'add_packetmonitor_permission',
  settingsKey: 'migration_082_packetmonitor_permission',
  sqlite: (db) => addPacketmonitorPermissionMigration.up(db),
  postgres: (client) => runMigration082Postgres(client),
  mysql: (pool) => runMigration082Mysql(pool),
});

registry.register({
  number: 83,
  name: 'add_missing_map_preference_columns',
  settingsKey: 'migration_083_map_preference_columns',
  sqlite: (db) => runMigration083Sqlite(db),
  postgres: (client) => runMigration083Postgres(client),
  mysql: (pool) => runMigration083Mysql(pool),
});

registry.register({
  number: 84,
  name: 'add_key_mismatch_columns',
  settingsKey: 'migration_084_key_mismatch_columns',
  sqlite: (db) => runMigration084Sqlite(db),
  postgres: (client) => runMigration084Postgres(client),
  mysql: (pool) => runMigration084Mysql(pool),
});

// Migration 085 is Postgres/MySQL only — SQLite migration is a no-op
registry.register({
  number: 85,
  name: 'fix_custom_themes_columns',
  settingsKey: 'migration_085_fix_custom_themes_columns',
  sqlite: (db) => fixCustomThemesColumnsMigration.up(db),
  postgres: (client) => runMigration085Postgres(client),
  mysql: (pool) => runMigration085Mysql(pool),
});

registry.register({
  number: 86,
  name: 'add_auto_distance_delete_log',
  settingsKey: 'migration_086_auto_distance_delete_log',
  sqlite: (db) => runMigration086Sqlite(db),
  postgres: (client) => runMigration086Postgres(client),
  mysql: (pool) => runMigration086Mysql(pool),
});

// Migration 087 is Postgres/MySQL only — SQLite migration is a no-op
registry.register({
  number: 87,
  name: 'fix_message_nodenum_bigint',
  settingsKey: 'migration_087_fix_message_nodenum_bigint',
  sqlite: (db) => fixMessageNodeNumBigintMigration.up(db),
  postgres: (client) => runMigration087Postgres(client),
  mysql: (pool) => runMigration087Mysql(pool),
});
