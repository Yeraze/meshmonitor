/**
 * Migration Registry Barrel File
 *
 * Registers all migrations in sequential order for use by the migration runner.
 * Migration 001 is the v3.7 baseline (selfIdempotent — handles its own detection).
 * Migrations 002-011 were originally 078-087 and retain their original settingsKeys
 * for upgrade compatibility.
 *
 * Total count is asserted by `src/db/migrations.test.ts`; update that test when
 * adding a new migration.
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
import { migration as addSourceIdToEmbedProfilesMigration, runMigration052Postgres, runMigration052Mysql } from '../server/migrations/052_add_source_id_to_embed_profiles.js';
import { migration as createWaypointsMigration, runMigration053Postgres, runMigration053Mysql } from '../server/migrations/053_create_waypoints.js';
import { migration as addWaypointsPermissionMigration, runMigration054Postgres, runMigration054Mysql } from '../server/migrations/054_add_waypoints_permission.js';
import { migration as seedGlobalWaypointsPermissionMigration, runMigration055Postgres, runMigration055Mysql } from '../server/migrations/055_seed_global_waypoints_permission.js';
import { migration as addShowTraceroutesToEmbedProfilesMigration, runMigration056Postgres, runMigration056Mysql } from '../server/migrations/056_add_show_traceroutes_to_embed_profiles.js';
import { migration as addSourceIdToMeshcoreTablesMigration, runMigration057Postgres, runMigration057Mysql } from '../server/migrations/057_add_source_id_to_meshcore_tables.js';
import { migration as collapseMeshcoreResourceMigration, runMigration058Postgres, runMigration058Mysql } from '../server/migrations/058_collapse_meshcore_resource.js';
import { migration as telemetrySourceNodeTypeTsIndexMigration, runMigration059Postgres, runMigration059Mysql } from '../server/migrations/059_telemetry_source_node_type_ts_index.js';
import { migration as meshcoreNodeTelemetryConfigMigration, runMigration060Postgres, runMigration060Mysql } from '../server/migrations/060_meshcore_node_telemetry_config.js';
import { migration as meshcoreNodesCompositePkMigration, runMigration061Postgres, runMigration061Mysql } from '../server/migrations/061_meshcore_nodes_composite_pk.js';
import { migration as meshcoreMessagesFromnameMigration, runMigration062Postgres, runMigration062Mysql } from '../server/migrations/062_meshcore_messages_fromname.js';
import { migration as dropSourceIdFromChannelDatabaseMigration, runMigration063Postgres, runMigration063Mysql } from '../server/migrations/063_drop_source_id_from_channel_database.js';
import { migration as addChannelDatabasePermissionMigration, runMigration064Postgres, runMigration064Mysql } from '../server/migrations/064_add_channel_database_permission.js';
import { migration as addMessageSourceAttributionMigration, runMigration065Postgres, runMigration065Mysql } from '../server/migrations/065_add_message_source_attribution.js';
import { migration as addTransportMechanismToNodesMigration, runMigration066Postgres, runMigration066Mysql } from '../server/migrations/066_add_transport_mechanism_to_nodes.js';
import { migration as addShowUdpRfNodesToMapPrefsMigration, runMigration067Postgres, runMigration067Mysql } from '../server/migrations/067_add_show_udp_rf_nodes_to_map_prefs.js';
import { migration as meshcoreNodesOutPathMigration, runMigration068Postgres, runMigration068Mysql } from '../server/migrations/068_meshcore_nodes_out_path.js';
import { migration as normalizeNodePublicKeysToBase64Migration, runMigration069Postgres, runMigration069Mysql } from '../server/migrations/069_normalize_node_public_keys_to_base64.js';
import { migration as meshcoreAdminCredentialMigration, runMigration070Postgres, runMigration070Mysql } from '../server/migrations/070_meshcore_admin_credential.js';
import { migration as dropLegacyPskLengthCheckMigration, runMigration071Postgres, runMigration071Mysql } from '../server/migrations/071_drop_legacy_psk_length_check.js';
import { migration as meshcoreRoomSyncMigration, runMigration072Postgres, runMigration072Mysql } from '../server/migrations/072_meshcore_room_sync.js';
import { migration as meshcoreNeighborInfoMigration, runMigration073Postgres, runMigration073Mysql } from '../server/migrations/073_meshcore_neighbor_info.js';
import { migration as addShowWaypointsToMapPrefsMigration, runMigration074Postgres, runMigration074Mysql } from '../server/migrations/074_add_show_waypoints_to_map_prefs.js';
import { migration as meshcorePacketLogMigration, runMigration075Postgres, runMigration075Mysql } from '../server/migrations/075_meshcore_packet_log.js';
import { migration as lowBatteryColumnsMigration, runMigration076Postgres, runMigration076Mysql } from '../server/migrations/076_add_low_battery_columns.js';
import { migration as normalizeMqttTelemetryKeysMigration, runMigration077Postgres, runMigration077Mysql } from '../server/migrations/077_normalize_mqtt_telemetry_keys.js';
import { migration as meshcorePacketLogBigintMigration, runMigration078PacketLogBigintPostgres, runMigration078PacketLogBigintMysql } from '../server/migrations/078_meshcore_packet_log_bigint_timestamp.js';
import { migration as dropResidualNotifPrefsUserIdUniqueMigration, runMigration079Postgres as runMigration079DropResidualPostgres, runMigration079Mysql as runMigration079DropResidualMysql } from '../server/migrations/079_drop_residual_notif_prefs_user_id_unique.js';
import { migration as lowBatteryVoltageThresholdMigration, runMigration080Postgres as runMigration080VoltagePostgres, runMigration080Mysql as runMigration080VoltageMysql } from '../server/migrations/080_add_low_battery_voltage_threshold.js';
import { migration as sourcesDisplayOrderMigration, runMigration081Postgres as runMigration081DisplayOrderPostgres, runMigration081Mysql as runMigration081DisplayOrderMysql } from '../server/migrations/081_add_sources_display_order.js';
import { migration as estimatedPositionsMigration, runMigration082EstimatedPositionsPostgres, runMigration082EstimatedPositionsMysql } from '../server/migrations/082_add_estimated_positions_table.js';
import { migration as spoofSuspectedMigration, runMigration083Postgres as runSpoofSuspectedPostgres, runMigration083Mysql as runSpoofSuspectedMysql } from '../server/migrations/083_add_spoof_suspected.js';
import { migration as autoFavoriteTargetsMigration, runMigration084Postgres as runAutoFavoriteTargetsPostgres, runMigration084Mysql as runAutoFavoriteTargetsMysql } from '../server/migrations/084_add_auto_favorite_targets.js';
import { migration as autoFavoriteAckMigration, runMigration085Postgres as runAutoFavoriteAckPostgres, runMigration085Mysql as runAutoFavoriteAckMysql } from '../server/migrations/085_add_auto_favorite_ack_status.js';
import { migration as autoFavoriteMaxNeighborAgeMigration, runMigration086Postgres as runAutoFavoriteMaxNeighborAgePostgres, runMigration086Mysql as runAutoFavoriteMaxNeighborAgeMysql } from '../server/migrations/086_add_auto_favorite_max_neighbor_age.js';
import { migration as mapMaxAgeMigration, runMigration087Postgres as runMapMaxAgePostgres, runMigration087Mysql as runMapMaxAgeMysql } from '../server/migrations/087_add_map_max_age_to_map_prefs.js';
import { migration as sourcePkiKeysMigration, runMigration088Postgres as runSourcePkiKeysPostgres, runMigration088Mysql as runSourcePkiKeysMysql } from '../server/migrations/088_add_source_pki_keys.js';
import { migration as positionSnrHopsMigration, runMigration089Postgres as runPositionSnrHopsPostgres, runMigration089Mysql as runPositionSnrHopsMysql } from '../server/migrations/089_add_position_snr_hops.js';
import { migration as positionPointsOnlyMigration, runMigration090Postgres as runPositionPointsOnlyPostgres, runMigration090Mysql as runPositionPointsOnlyMysql } from '../server/migrations/090_add_position_points_only_to_map_prefs.js';
import { migration as estimatedPositionsDoublePrecisionMigration, runMigration091Postgres as runEstimatedPositionsDoublePrecisionPostgres, runMigration091Mysql as runEstimatedPositionsDoublePrecisionMysql } from '../server/migrations/091_estimated_positions_double_precision.js';
import { migration as hideFromMapMigration, runMigration092Postgres as runHideFromMapPostgres, runMigration092Mysql as runHideFromMapMysql } from '../server/migrations/092_add_hide_from_map_to_nodes.js';
import { migration as autoackMatrixMigration, runMigration093Postgres as runAutoackMatrixPostgres, runMigration093Mysql as runAutoackMatrixMysql } from '../server/migrations/093_autoack_matrix.js';
import { migration as meshcoreNodeFavoriteMigration, runMigration094Postgres as runMeshcoreNodeFavoritePostgres, runMigration094Mysql as runMeshcoreNodeFavoriteMysql } from '../server/migrations/094_add_meshcore_node_favorite.js';
import { migration as deadDropMigration, runMigration095Postgres as runDeadDropPostgres, runMigration095Mysql as runDeadDropMysql } from '../server/migrations/095_create_dead_drop.js';
import { migration as meshcoreNeighborTimestampBigintMigration, runMigration096Postgres as runMeshcoreNeighborTimestampBigintPostgres, runMigration096Mysql as runMeshcoreNeighborTimestampBigintMysql } from '../server/migrations/096_meshcore_neighbor_timestamp_bigint.js';
import { migration as traceroutePacketIdMigration, runMigration097Postgres as runTraceroutePacketIdPostgres, runMigration097Mysql as runTraceroutePacketIdMysql } from '../server/migrations/097_add_packet_id_to_traceroutes.js';
import { migration as createAutomationsMigration, runMigration098Postgres, runMigration098Mysql } from '../server/migrations/098_create_automations.js';
import { migration as createAutomationVariablesMigration, runMigration099Postgres, runMigration099Mysql } from '../server/migrations/099_create_automation_variables.js';
import { migration as meshcoreChannelScopeMigration, runMigration100Postgres as runMeshcoreChannelScopePostgres, runMigration100Mysql as runMeshcoreChannelScopeMysql } from '../server/migrations/100_meshcore_channel_scope.js';
import { migration as nodeUnmessagableMigration, runMigration101Postgres as runNodeUnmessagablePostgres, runMigration101Mysql as runNodeUnmessagableMysql } from '../server/migrations/101_add_node_unmessagable.js';
import { migration as meshcoreHeardRepeatersMigration, runMigration102Postgres as runMeshcoreHeardRepeatersPostgres, runMigration102Mysql as runMeshcoreHeardRepeatersMysql } from '../server/migrations/102_create_meshcore_heard_repeaters.js';
import { migration as consolidateMqttChannelsMigration, runMigration103Postgres as runConsolidateMqttChannelsPostgres, runMigration103Mysql as runConsolidateMqttChannelsMysql } from '../server/migrations/103_consolidate_mqtt_channels.js';
import { migration as channelDatabaseHashMigration, runMigration104Postgres as runChannelDatabaseHashPostgres, runMigration104Mysql as runChannelDatabaseHashMysql } from '../server/migrations/104_add_channel_database_hash.js';
import { migration as meshcoreMessageRouteMigration, runMigration105Postgres as runMeshcoreMessageRoutePostgres, runMigration105Mysql as runMeshcoreMessageRouteMysql } from '../server/migrations/105_add_meshcore_message_route.js';
import { migration as meshcoreMessageScopeMigration, runMigration106Postgres as runMeshcoreMessageScopePostgres, runMigration106Mysql as runMeshcoreMessageScopeMysql } from '../server/migrations/106_add_meshcore_message_scope.js';
import { migration as clearNullIslandMigration, runMigration107Postgres as runClearNullIslandPostgres, runMigration107Mysql as runClearNullIslandMysql } from '../server/migrations/107_clear_null_island_positions.js';
import { migration as meshcoreSavedRegionsMigration, runMigration108Postgres as runMeshcoreSavedRegionsPostgres, runMigration108Mysql as runMeshcoreSavedRegionsMysql } from '../server/migrations/108_meshcore_saved_regions.js';
import { migration as clampFutureTracerouteMigration, runMigration109Postgres as runClampFutureTraceroutePostgres, runMigration109Mysql as runClampFutureTracerouteMysql } from '../server/migrations/109_clamp_future_traceroute_timestamps.js';
import { migration as meshcorePositionHistoryMigration, runMigration110Postgres as runMeshcorePositionHistoryPostgres, runMigration110Mysql as runMeshcorePositionHistoryMysql } from '../server/migrations/110_add_meshcore_position_history.js';
import { migration as meshcoreNodePositionSourceMigration, runMigration111Postgres as runMeshcoreNodePositionSourcePostgres, runMigration111Mysql as runMeshcoreNodePositionSourceMysql } from '../server/migrations/111_meshcore_node_position_source.js';
import { migration as nodeNotesMigration, runMigration112Postgres as runNodeNotesPostgres, runMigration112Mysql as runNodeNotesMysql } from '../server/migrations/112_add_notes_to_nodes.js';
import { migration as bootstrapOnlyIndexesMigration, runMigration113Postgres as runBootstrapOnlyIndexesPostgres, runMigration113Mysql as runBootstrapOnlyIndexesMysql } from '../server/migrations/113_add_bootstrap_only_indexes.js';
import { migration as meshcorePathfindingTargetsMigration, runMigration114Postgres as runMeshcorePathfindingTargetsPostgres, runMigration114Mysql as runMeshcorePathfindingTargetsMysql } from '../server/migrations/114_create_meshcore_pathfinding_targets.js';
import { migration as dropInlineNotifPrefsUserIdUniqueMigration, runMigration115Postgres as runDropInlineNotifPrefsUserIdUniquePostgres, runMigration115Mysql as runDropInlineNotifPrefsUserIdUniqueMysql } from '../server/migrations/115_drop_inline_notif_prefs_user_id_unique.js';
import { migration as trimOutOfRangeNodePositionsMigration, runMigration116Postgres as runTrimOutOfRangeNodePositionsPostgres, runMigration116Mysql as runTrimOutOfRangeNodePositionsMysql } from '../server/migrations/116_trim_out_of_range_node_positions.js';
import { migration as dropUpgradeHistoryMigration, runMigration117Postgres as runDropUpgradeHistoryPostgres, runMigration117Mysql as runDropUpgradeHistoryMysql } from '../server/migrations/117_drop_upgrade_history.js';
import { migration as dropLegacyAuthProviderCheckMigration, runMigration118Postgres as runDropLegacyAuthProviderCheckPostgres, runMigration118Mysql as runDropLegacyAuthProviderCheckMysql } from '../server/migrations/118_drop_legacy_auth_provider_check.js';
import { migration as themeTilesetsMigration, runMigration119Postgres as runThemeTilesetsPostgres, runMigration119Mysql as runThemeTilesetsMysql } from '../server/migrations/119_add_theme_tilesets.js';
import { migration as addReasonToIgnoredNodesMigration, runMigration120Postgres as runAddReasonToIgnoredNodesPostgres, runMigration120Mysql as runAddReasonToIgnoredNodesMysql } from '../server/migrations/120_add_reason_to_ignored_nodes.js';
import { migration as mqttPacketLogMigration, runMigration121Postgres, runMigration121Mysql } from '../server/migrations/121_mqtt_packet_log.js';
import { migration as cleanupOrphanedSourceNodesMigration, runMigration122Postgres, runMigration122Mysql } from '../server/migrations/122_cleanup_orphaned_source_nodes.js';
import { migration as fixMqttDirectedMessageChannelMigration, runMigration123Postgres, runMigration123Mysql } from '../server/migrations/123_fix_mqtt_directed_message_channel.js';
import { migration as addPositionLocationSourceMigration, runMigration124Postgres, runMigration124Mysql } from '../server/migrations/124_add_position_location_source.js';
import { migration as addXeddsaSignedMigration, runMigration125Postgres, runMigration125Mysql } from '../server/migrations/125_add_xeddsa_signed_to_packet_log.js';
import { migration as addTransportFlagsMigration, runMigration126Postgres, runMigration126Mysql } from '../server/migrations/126_add_transport_flags_to_nodes.js';
import { migration as addAtakContactsMigration, runMigration127Postgres, runMigration127Mysql } from '../server/migrations/127_add_atak_contacts.js';

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

// ---------------------------------------------------------------------------
// Migration 052: Add nullable sourceId column to embed_profiles. NULL = "all
// sources" (preserves pre-migration behaviour where embed routes returned
// data unfiltered across sources).
// ---------------------------------------------------------------------------

registry.register({
  number: 52,
  name: 'add_source_id_to_embed_profiles',
  settingsKey: 'migration_052_add_source_id_to_embed_profiles',
  sqlite: (db) => addSourceIdToEmbedProfilesMigration.up(db),
  postgres: (client) => runMigration052Postgres(client),
  mysql: (pool) => runMigration052Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 053: Create the per-source `waypoints` table for Meshtastic
// WAYPOINT_APP packets. Composite PK (source_id, waypoint_id) with a
// CASCADE FK to sources(id) so removing a source clears its waypoints.
// ---------------------------------------------------------------------------

registry.register({
  number: 53,
  name: 'create_waypoints',
  settingsKey: 'migration_053_create_waypoints',
  sqlite: (db) => createWaypointsMigration.up(db),
  postgres: (client) => runMigration053Postgres(client),
  mysql: (pool) => runMigration053Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 054: Seed per-source `waypoints` permission grants by mirroring
// each user's existing `messages` row for the same source. Lets existing
// users see waypoints at the same level as their messages access without
// granting access to users who had none.
// ---------------------------------------------------------------------------

registry.register({
  number: 54,
  name: 'add_waypoints_permission',
  settingsKey: 'migration_054_add_waypoints_permission',
  sqlite: (db) => addWaypointsPermissionMigration.up(db),
  postgres: (client) => runMigration054Postgres(client),
  mysql: (pool) => runMigration054Mysql(pool),
});

registry.register({
  number: 55,
  name: 'seed_global_waypoints_permission',
  settingsKey: 'migration_055_seed_global_waypoints_permission',
  sqlite: (db) => seedGlobalWaypointsPermissionMigration.up(db),
  postgres: (client) => runMigration055Postgres(client),
  mysql: (pool) => runMigration055Mysql(pool),
});

registry.register({
  number: 56,
  name: 'add_show_traceroutes_to_embed_profiles',
  settingsKey: 'migration_056_add_show_traceroutes_to_embed_profiles',
  sqlite: (db) => addShowTraceroutesToEmbedProfilesMigration.up(db),
  postgres: (client) => runMigration056Postgres(client),
  mysql: (pool) => runMigration056Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 057: Add nullable sourceId to meshcore_nodes / meshcore_messages
// (mirrors migration 021 for Meshtastic) and synthesise a legacy default
// MeshCore source for any pre-existing rows. First slice of the MeshCore
// per-source refactor — the manager registry now keys on sourceId.
// ---------------------------------------------------------------------------

registry.register({
  number: 57,
  name: 'add_source_id_to_meshcore_tables',
  settingsKey: 'migration_057_add_source_id_to_meshcore_tables',
  sqlite: (db) => addSourceIdToMeshcoreTablesMigration.up(db),
  postgres: (client) => runMigration057Postgres(client),
  mysql: (pool) => runMigration057Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 058: Collapse the global `meshcore` permission resource into
// the per-source sourcey set. Expands each global meshcore grant into
// (connection, configuration, nodes, messages) rows scoped per
// meshcore-typed source, then drops the originals. Slice 3 of the
// MeshCore per-source refactor.
// ---------------------------------------------------------------------------

registry.register({
  number: 58,
  name: 'collapse_meshcore_resource',
  settingsKey: 'migration_058_collapse_meshcore_resource',
  sqlite: (db) => collapseMeshcoreResourceMigration.up(db),
  postgres: (client) => runMigration058Postgres(client),
  mysql: (pool) => runMigration058Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 059: Add (sourceId, nodeId, telemetryType, timestamp DESC) index
// to back the MeshCore Info-page time-series queries. Migration 049 covered
// the equality columns but stopped short of `timestamp`, forcing a sort on
// each range fetch. Idempotent across SQLite / PostgreSQL / MySQL.
// ---------------------------------------------------------------------------

registry.register({
  number: 59,
  name: 'telemetry_source_node_type_ts_index',
  settingsKey: 'migration_059_telemetry_source_node_type_ts_index',
  sqlite: (db) => telemetrySourceNodeTypeTsIndexMigration.up(db),
  postgres: (client) => runMigration059Postgres(client),
  mysql: (pool) => runMigration059Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 060: Per-node remote-telemetry config columns on meshcore_nodes
// (telemetryEnabled, telemetryIntervalMinutes, lastTelemetryRequestAt).
// Read by the MeshCoreRemoteTelemetryScheduler each tick. Idempotent across
// SQLite / PostgreSQL / MySQL.
// ---------------------------------------------------------------------------

registry.register({
  number: 60,
  name: 'meshcore_node_telemetry_config',
  settingsKey: 'migration_060_meshcore_node_telemetry_config',
  sqlite: (db) => meshcoreNodeTelemetryConfigMigration.up(db),
  postgres: (client) => runMigration060Postgres(client),
  mysql: (pool) => runMigration060Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 061: meshcore_nodes composite PK (sourceId, publicKey). Previously
// publicKey alone was the PK, which collapsed the same MeshCore node under
// two sources into one row and raised UNIQUE constraint failures on any
// second-source write (observed via the per-source telemetry-config endpoint).
// Mirrors migration 029 for Meshtastic nodes. Idempotent.
// ---------------------------------------------------------------------------

registry.register({
  number: 61,
  name: 'meshcore_nodes_composite_pk',
  settingsKey: 'migration_061_meshcore_nodes_composite_pk',
  sqlite: (db) => meshcoreNodesCompositePkMigration.up(db),
  postgres: (client) => runMigration061Postgres(client),
  mysql: (pool) => runMigration061Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 062: Add `fromName` to `meshcore_messages`.
// MeshCore channel messages carry no per-sender identity on the wire — the
// sender prefixes their name onto the text body. MeshCoreManager parses it
// into `fromName` on the in-memory message. This column persists it so
// channel messages retain sender attribution after restart.
// ---------------------------------------------------------------------------

registry.register({
  number: 62,
  name: 'meshcore_messages_fromname',
  settingsKey: 'migration_062_meshcore_messages_fromname',
  sqlite: (db) => meshcoreMessagesFromnameMigration.up(db),
  postgres: (client) => runMigration062Postgres(client),
  mysql: (pool) => runMigration062Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 063: Drop the never-used `sourceId` column from `channel_database`.
// Channel-database entries are pooled into one global decryption cache by
// `channelDecryptionService` — no read path filters by source — so the
// column has been dead since migration 021. Removing it ahead of moving the
// UI from Device Configuration to Global Settings.
// ---------------------------------------------------------------------------

registry.register({
  number: 63,
  name: 'drop_source_id_from_channel_database',
  settingsKey: 'migration_063_drop_source_id_from_channel_database',
  sqlite: (db) => dropSourceIdFromChannelDatabaseMigration.up(db),
  postgres: (client) => runMigration063Postgres(client),
  mysql: (pool) => runMigration063Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 064: Backfill the global `channel_database` permission resource.
// Introduces `channel_database` as a global (sourceId IS NULL) permission and
// grants every existing admin a row with canRead=true, canWrite=true. The
// channel/PSK library is pooled across sources by channelDecryptionService,
// so a single global grant governs access. Non-admins get no row by default.
// ---------------------------------------------------------------------------

registry.register({
  number: 64,
  name: 'add_channel_database_permission',
  settingsKey: 'migration_064_add_channel_database_permission',
  sqlite: (db) => addChannelDatabasePermissionMigration.up(db),
  postgres: (client) => runMigration064Postgres(client),
  mysql: (pool) => runMigration064Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 065: Add source_ip + source_path columns to messages table.
// Two nullable text columns so operators can trace WHICH client/API caller
// injected a given message. Existing rows get NULL; backward compatible.
// ---------------------------------------------------------------------------

registry.register({
  number: 65,
  name: 'add_message_source_attribution',
  settingsKey: 'migration_065_add_message_source_attribution',
  sqlite: (db) => addMessageSourceAttributionMigration.up(db),
  postgres: (client) => runMigration065Postgres(client),
  mysql: (pool) => runMigration065Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 066: Add transportMechanism column to nodes + backfill from
// viaMqtt. Lifts the per-packet TransportMechanism enum onto the node row
// so the map's Show RF / UDP / MQTT toggles can filter markers without a
// per-packet scan. Existing rows with viaMqtt=true map to MQTT(5); the
// rest default to LORA(1). Closes the node-level half of #3112.
// ---------------------------------------------------------------------------

registry.register({
  number: 66,
  name: 'add_transport_mechanism_to_nodes',
  settingsKey: 'migration_066_add_transport_mechanism_to_nodes',
  sqlite: (db) => addTransportMechanismToNodesMigration.up(db),
  postgres: (client) => runMigration066Postgres(client),
  mysql: (pool) => runMigration066Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 067: Add show_udp_nodes + show_rf_nodes columns to
// user_map_preferences. Companion to 066 — persists the new per-transport
// map-visibility toggles introduced for #3112. Defaults: RF on, UDP off.
// ---------------------------------------------------------------------------

registry.register({
  number: 67,
  name: 'add_show_udp_rf_nodes_to_map_prefs',
  settingsKey: 'migration_067_add_show_udp_rf_nodes_to_map_prefs',
  sqlite: (db) => addShowUdpRfNodesToMapPrefsMigration.up(db),
  postgres: (client) => runMigration067Postgres(client),
  mysql: (pool) => runMigration067Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 068: Persist MeshCore per-contact route ("out_path") on
// meshcore_nodes. Adds `out_path TEXT` (comma-separated hex hops) and
// `path_len INTEGER`. NULL on both means the firmware's OUT_PATH_UNKNOWN
// sentinel — next send will flood.
// ---------------------------------------------------------------------------

registry.register({
  number: 68,
  name: 'meshcore_nodes_out_path',
  settingsKey: 'migration_068_meshcore_nodes_out_path',
  sqlite: (db) => meshcoreNodesOutPathMigration.up(db),
  postgres: (client) => runMigration068Postgres(client),
  mysql: (pool) => runMigration068Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 069: Normalize nodes.publicKey to base64. Cleanup for the MQTT
// ingest path that stored publicKey as hex while every other path used
// base64 — caused false-positive key-mismatch warnings every time a
// MQTT-seen node later sent NodeInfo over the direct radio. Converts every
// row matching `^[0-9a-f]{64}$` (lowercase 32-byte hex) to its base64
// equivalent. Idempotent.
// ---------------------------------------------------------------------------

registry.register({
  number: 69,
  name: 'normalize_node_public_keys_to_base64',
  settingsKey: 'migration_069_normalize_node_public_keys_to_base64',
  sqlite: (db) => normalizeNodePublicKeysToBase64Migration.up(db),
  postgres: (client) => runMigration069Postgres(client),
  mysql: (pool) => runMigration069Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 070: Add `adminCredential` TEXT column to meshcore_nodes for
// storing AES-256-GCM-encrypted MeshCore admin passwords. Persistence is
// gated by MeshCoreCredentialStore on SESSION_SECRET being configured (not
// auto-generated). Stored value is a JSON envelope with KDF version + key
// fingerprint so a rotated SESSION_SECRET can be detected and surfaced to
// the user instead of silently failing with an auth-tag error.
// ---------------------------------------------------------------------------

registry.register({
  number: 70,
  name: 'meshcore_admin_credential',
  settingsKey: 'migration_070_meshcore_admin_credential',
  sqlite: (db) => meshcoreAdminCredentialMigration.up(db),
  postgres: (client) => runMigration070Postgres(client),
  mysql: (pool) => runMigration070Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 071: Drop the legacy `CHECK (psk_length IN (16, 32))` constraint
// from the SQLite `channel_database` table on pre-v3.7 installs. The
// constraint rejects `pskLength = 1` (shorthand `AQ==` default key) so MQTT
// default-channel bootstrap fails on every source start. The constraint was
// removed from the v3.7 baseline, but `CREATE TABLE IF NOT EXISTS` leaves
// upgraded tables intact — this migration rebuilds the table to strip it.
// PG/MySQL: no-op (constraint never existed there).
// ---------------------------------------------------------------------------

registry.register({
  number: 71,
  name: 'drop_legacy_psk_length_check',
  settingsKey: 'migration_071_drop_legacy_psk_length_check',
  sqlite: (db) => dropLegacyPskLengthCheckMigration.up(db),
  postgres: (client) => runMigration071Postgres(client),
  mysql: (pool) => runMigration071Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 072: Room server sync and credential columns on meshcore_nodes
// ---------------------------------------------------------------------------

registry.register({
  number: 72,
  name: 'meshcore_room_sync',
  settingsKey: 'migration_072_meshcore_room_sync',
  sqlite: (db) => meshcoreRoomSyncMigration.up(db),
  postgres: (client) => runMigration072Postgres(client),
  mysql: (pool) => runMigration072Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 073: Create meshcore_neighbor_info table for storing parsed
// neighbor data from MeshCore repeaters' CLI `neighbors` command.
// ---------------------------------------------------------------------------

registry.register({
  number: 73,
  name: 'meshcore_neighbor_info',
  settingsKey: 'migration_073_meshcore_neighbor_info',
  sqlite: (db) => meshcoreNeighborInfoMigration.up(db),
  postgres: (client) => runMigration073Postgres(client),
  mysql: (pool) => runMigration073Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 074: Add `show_waypoints` column to user_map_preferences. Persists
// the waypoint marker visibility toggle alongside the other Map Features
// toggles. Default TRUE (opt-out) so existing installs keep showing waypoints.
// ---------------------------------------------------------------------------

registry.register({
  number: 74,
  name: 'add_show_waypoints_to_map_prefs',
  settingsKey: 'migration_074_add_show_waypoints_to_map_prefs',
  sqlite: (db) => addShowWaypointsToMapPrefsMigration.up(db),
  postgres: (client) => runMigration074Postgres(client),
  mysql: (pool) => runMigration074Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 075: Create meshcore_packet_log table for the MeshCore Packet
// Monitor. One row per OTA packet seen via the companion LogRxData (0x88)
// push; capture is opt-in via the `meshcore_packet_log_enabled` setting.
// ---------------------------------------------------------------------------

registry.register({
  number: 75,
  name: 'meshcore_packet_log',
  settingsKey: 'migration_075_meshcore_packet_log',
  sqlite: (db) => meshcorePacketLogMigration.up(db),
  postgres: (client) => runMigration075Postgres(client),
  mysql: (pool) => runMigration075Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 076: Add notifyOnLowBattery / lowBatteryThreshold columns to
// user_notification_preferences for per-user low-battery alerts on monitored
// nodes. Reuses the inactive-node monitored_nodes list. Implements #3305.
// ---------------------------------------------------------------------------

registry.register({
  number: 76,
  name: 'add_low_battery_columns',
  settingsKey: 'migration_076_add_low_battery_columns',
  sqlite: (db) => lowBatteryColumnsMigration.up(db),
  postgres: (client) => runMigration076Postgres(client),
  mysql: (pool) => runMigration076Mysql(pool),
});
// ---------------------------------------------------------------------------
// Migration 077: Rewrite historical MQTT-ingested telemetry rows from dotted
// group-prefixed keys (e.g. environment.barometricPressure) to the canonical
// short keys serial ingestion uses (pressure), backfilling units. Implements
// #3314 so MQTT-sourced environment data becomes visible in the UI.
// ---------------------------------------------------------------------------

registry.register({
  number: 77,
  name: 'normalize_mqtt_telemetry_keys',
  settingsKey: 'migration_077_normalize_mqtt_telemetry_keys',
  sqlite: (db) => normalizeMqttTelemetryKeysMigration.up(db),
  postgres: (client) => runMigration077Postgres(client),
  mysql: (pool) => runMigration077Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 078: Widen meshcore_packet_log.timestamp/createdAt to BIGINT on
// PostgreSQL/MySQL. They held ms-epoch values that overflow 32-bit INTEGER,
// breaking the retention cleanup DELETE with SQLSTATE 22003. SQLite no-op.
// ---------------------------------------------------------------------------

registry.register({
  number: 78,
  name: 'meshcore_packet_log_bigint_timestamp',
  settingsKey: 'migration_078_meshcore_packet_log_bigint_timestamp',
  sqlite: (db) => meshcorePacketLogBigintMigration.up(db),
  postgres: (client) => runMigration078PacketLogBigintPostgres(client),
  mysql: (pool) => runMigration078PacketLogBigintMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 079: Drop residual single-column unique indexes on
// user_notification_preferences.user_id. Migrations 028 and 051 dropped the
// index by known names; this migration uses PRAGMA introspection on SQLite to
// catch any naming variant that survived earlier cleanup, fixing:
//   UNIQUE constraint failed: user_notification_preferences.user_id
// when saving notification preferences for a second source.
// ---------------------------------------------------------------------------

registry.register({
  number: 79,
  name: 'drop_residual_notif_prefs_user_id_unique',
  settingsKey: 'migration_079_drop_residual_notif_prefs_user_id_unique',
  sqlite: (db) => dropResidualNotifPrefsUserIdUniqueMigration.up(db),
  postgres: (client) => runMigration079DropResidualPostgres(client),
  mysql: (pool) => runMigration079DropResidualMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 080: Add lowBatteryVoltageThreshold to user_notification_preferences.
// MeshCore nodes report battery as a voltage (mV) rather than a percentage, so
// low-battery alerts for them compare batteryMv against this threshold.
// See https://github.com/Yeraze/meshmonitor/issues/3331
// ---------------------------------------------------------------------------

registry.register({
  number: 80,
  name: 'add_low_battery_voltage_threshold',
  settingsKey: 'migration_080_add_low_battery_voltage_threshold',
  sqlite: (db) => lowBatteryVoltageThresholdMigration.up(db),
  postgres: (client) => runMigration080VoltagePostgres(client),
  mysql: (pool) => runMigration080VoltageMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 081: Add displayOrder to sources, enabling user-controlled
// drag-and-drop reordering of the source list on the Unified View sidebar.
// See https://github.com/Yeraze/meshmonitor/issues/3338
// ---------------------------------------------------------------------------

registry.register({
  number: 81,
  name: 'add_sources_display_order',
  settingsKey: 'migration_081_add_sources_display_order',
  sqlite: (db) => sourcesDisplayOrderMigration.up(db),
  postgres: (client) => runMigration081DisplayOrderPostgres(client),
  mysql: (pool) => runMigration081DisplayOrderMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 082: Add the global estimated_positions table and purge obsolete
// per-source estimate telemetry rows. Position estimation becomes a single
// global, scheduled, multilateration-based computation pooling all Meshtastic
// sources (incl. MQTT). See https://github.com/Yeraze/meshmonitor/issues/3271
// ---------------------------------------------------------------------------

registry.register({
  number: 82,
  name: 'add_estimated_positions_table',
  settingsKey: 'migration_082_add_estimated_positions_table',
  sqlite: (db) => estimatedPositionsMigration.up(db),
  postgres: (client) => runMigration082EstimatedPositionsPostgres(client),
  mysql: (pool) => runMigration082EstimatedPositionsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 083: Add spoof/impersonation flags (messages.spoofSuspected and
// packet_log.spoof_suspected) for local-node impersonation detection.
// See https://github.com/Yeraze/meshmonitor/issues/2584
// ---------------------------------------------------------------------------

registry.register({
  number: 83,
  name: 'add_spoof_suspected',
  settingsKey: 'migration_083_add_spoof_suspected',
  sqlite: (db) => spoofSuspectedMigration.up(db),
  postgres: (client) => runSpoofSuspectedPostgres(client),
  mysql: (pool) => runSpoofSuspectedMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 084: Automated Remote Favorites Management (issue #2608). Adds the
// per-source/per-target auto_favorite_targets config table and the
// auto_favorite_assignments tracking ledger that backs the scheduler which
// keeps favorites up to date on remote infrastructure nodes via Remote Admin.
// ---------------------------------------------------------------------------

registry.register({
  number: 84,
  name: 'add_auto_favorite_targets',
  settingsKey: 'migration_084_add_auto_favorite_targets',
  sqlite: (db) => autoFavoriteTargetsMigration.up(db),
  postgres: (client) => runAutoFavoriteTargetsPostgres(client),
  mysql: (pool) => runAutoFavoriteTargetsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 085: Track the routing-ACK result of each remote favorite command
// (issue #2608 follow-up). Adds lastAckStatus + lastAckAt to
// auto_favorite_assignments.
// ---------------------------------------------------------------------------

registry.register({
  number: 85,
  name: 'add_auto_favorite_ack_status',
  settingsKey: 'migration_085_add_auto_favorite_ack_status',
  sqlite: (db) => autoFavoriteAckMigration.up(db),
  postgres: (client) => runAutoFavoriteAckPostgres(client),
  mysql: (pool) => runAutoFavoriteAckMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 086: Add maxNeighborAgeHours to auto_favorite_targets — reuse an
// on-file NeighborInfo record newer than this many hours instead of requesting
// a fresh one (issue #2608 follow-up).
// ---------------------------------------------------------------------------

registry.register({
  number: 86,
  name: 'add_auto_favorite_max_neighbor_age',
  settingsKey: 'migration_086_add_auto_favorite_max_neighbor_age',
  sqlite: (db) => autoFavoriteMaxNeighborAgeMigration.up(db),
  postgres: (client) => runAutoFavoriteMaxNeighborAgePostgres(client),
  mysql: (pool) => runAutoFavoriteMaxNeighborAgeMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 087: Add map_max_age_hours to user_map_preferences — persists the
// Map Features "maximum age" slider (#3322). NULL = follow maxNodeAgeHours.
// ---------------------------------------------------------------------------

registry.register({
  number: 87,
  name: 'add_map_max_age_to_map_prefs',
  settingsKey: 'migration_087_add_map_max_age_to_map_prefs',
  sqlite: (db) => mapMaxAgeMigration.up(db),
  postgres: (client) => runMapMaxAgePostgres(client),
  mysql: (pool) => runMapMaxAgeMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 088: source_pki_keys — per-source encrypted X25519 private key for
// server-side PKI direct-message decryption (issue #3441).
// ---------------------------------------------------------------------------

registry.register({
  number: 88,
  name: 'add_source_pki_keys',
  settingsKey: 'migration_088_add_source_pki_keys',
  sqlite: (db) => sourcePkiKeysMigration.up(db),
  postgres: (client) => runSourcePkiKeysPostgres(client),
  mysql: (pool) => runSourcePkiKeysMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 089: telemetry rxSnr/hopStart/hopLimit — capture per-position-fix
// receive SNR and hop metadata for the position-history hover tooltip (#3492).
// ---------------------------------------------------------------------------

registry.register({
  number: 89,
  name: 'add_position_snr_hops',
  settingsKey: 'migration_089_add_position_snr_hops',
  sqlite: (db) => positionSnrHopsMigration.up(db),
  postgres: (client) => runPositionSnrHopsPostgres(client),
  mysql: (pool) => runPositionSnrHopsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 090: user_map_preferences.position_history_points_only — persist
// the Map Features "points only" position-history toggle (#3492).
// ---------------------------------------------------------------------------

registry.register({
  number: 90,
  name: 'add_position_points_only_to_map_prefs',
  settingsKey: 'migration_090_add_position_points_only_to_map_prefs',
  sqlite: (db) => positionPointsOnlyMigration.up(db),
  postgres: (client) => runPositionPointsOnlyPostgres(client),
  mysql: (pool) => runPositionPointsOnlyMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 091: estimated_positions lat/lon/uncertaintyKm → DOUBLE PRECISION
// (PostgreSQL only). The original REAL columns (~7 sig. digits) caused visible
// coordinate rounding for estimated node positions (#3513).
// ---------------------------------------------------------------------------

registry.register({
  number: 91,
  name: 'estimated_positions_double_precision',
  settingsKey: 'migration_091_estimated_positions_double_precision',
  sqlite: (db) => estimatedPositionsDoublePrecisionMigration.up(db),
  postgres: (client) => runEstimatedPositionsDoublePrecisionPostgres(client),
  mysql: (pool) => runEstimatedPositionsDoublePrecisionMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 092: nodes.hideFromMap — per-node "Hide from Map" toggle (#3549).
// Suppresses the node's map marker only; the node stays visible everywhere else.
// ---------------------------------------------------------------------------

registry.register({
  number: 92,
  name: 'add_hide_from_map_to_nodes',
  settingsKey: 'migration_092_add_hide_from_map_to_nodes',
  sqlite: (db) => hideFromMapMigration.up(db),
  postgres: (client) => runHideFromMapPostgres(client),
  mysql: (pool) => runHideFromMapMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 093: fold legacy hop-only auto-ack settings into the new
// {Channel,Direct} × {ZeroHop,MultiHop} matrix, each cell with its own
// Reply / Tapback / Respond-via-DM toggles (discussion #3564).
// ---------------------------------------------------------------------------

registry.register({
  number: 93,
  name: 'autoack_matrix',
  settingsKey: 'migration_093_autoack_matrix',
  sqlite: (db) => autoackMatrixMigration.up(db),
  postgres: (client) => runAutoackMatrixPostgres(client),
  mysql: (pool) => runAutoackMatrixMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 094: server-side favorite flag on meshcore_nodes. MeshCore has no
// native favorite concept, so the flag is stored locally and never pushed to
// the device; favorited nodes pin to the top of the node list (issue #3588).
// ---------------------------------------------------------------------------

registry.register({
  number: 94,
  name: 'add_meshcore_node_favorite',
  settingsKey: 'migration_094_add_meshcore_node_favorite',
  sqlite: (db) => meshcoreNodeFavoriteMigration.up(db),
  postgres: (client) => runMeshcoreNodeFavoritePostgres(client),
  mysql: (pool) => runMeshcoreNodeFavoriteMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 095: dead_drop_messages — per-source async message store
// ("mesh voicemail"). Backs the Dead Drop / Mailbox auto-responder feature.
// ---------------------------------------------------------------------------

registry.register({
  number: 95,
  name: 'create_dead_drop',
  settingsKey: 'migration_095_create_dead_drop',
  sqlite: (db) => deadDropMigration.up(db),
  postgres: (client) => runDeadDropPostgres(client),
  mysql: (pool) => runDeadDropMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 096: widen meshcore_neighbor_info.timestamp / .createdAt to BIGINT
// on PostgreSQL and MySQL. Both store ms-epoch values (Date.now()), which
// overflow signed 32-bit INTEGER/INT and crashed getNeighbors in production.
// SQLite INTEGER is already 64-bit (no-op there).
// ---------------------------------------------------------------------------

registry.register({
  number: 96,
  name: 'meshcore_neighbor_timestamp_bigint',
  settingsKey: 'migration_096_meshcore_neighbor_timestamp_bigint',
  sqlite: (db) => meshcoreNeighborTimestampBigintMigration.up(db),
  postgres: (client) => runMeshcoreNeighborTimestampBigintPostgres(client),
  mysql: (pool) => runMeshcoreNeighborTimestampBigintMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 097: add traceroutes.packetId (#3623). Records the originating
// Meshtastic packet id so traces can be correlated across sources and grouped
// per-packet. BIGINT on PG/MySQL (packet ids are unsigned 32-bit); SQLite
// INTEGER is already 64-bit.
// ---------------------------------------------------------------------------

registry.register({
  number: 97,
  name: 'add_packet_id_to_traceroutes',
  settingsKey: 'migration_097_add_packet_id_to_traceroutes',
  sqlite: (db) => traceroutePacketIdMigration.up(db),
  postgres: (client) => runTraceroutePacketIdPostgres(client),
  mysql: (pool) => runTraceroutePacketIdMysql(pool),
});
// ---------------------------------------------------------------------------
// Migration 098: create automations + automation_runs tables (#3653).
// Foundation for the generic Automation Engine. `automations` is GLOBAL (no
// sourceId) by design; `automation_runs` is the execution log (Phase 1a) and
// stateful run store (Phase 1b).
// ---------------------------------------------------------------------------

registry.register({
  number: 98,
  name: 'create_automations',
  settingsKey: 'migration_098_create_automations',
  sqlite: (db) => createAutomationsMigration.up(db),
  postgres: (client) => runMigration098Postgres(client),
  mysql: (pool) => runMigration098Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 099: create automation_variables + automation_variable_values
// (#3653). User-defined variables for the Automation Engine (global registry +
// per-scope values; flag TTL anti-spam). See AUTOMATION_ENGINE_PLAN §5.2.
// ---------------------------------------------------------------------------

registry.register({
  number: 99,
  name: 'create_automation_variables',
  settingsKey: 'migration_099_create_automation_variables',
  sqlite: (db) => createAutomationVariablesMigration.up(db),
  postgres: (client) => runMigration099Postgres(client),
  mysql: (pool) => runMigration099Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 100: add channels.scope (#3667). MeshCore region/scope tag per
// channel; MeshMonitor-owned (never reported by the device), NULL = inherit
// the source default scope / unscoped.
// ---------------------------------------------------------------------------

registry.register({
  number: 100,
  name: 'meshcore_channel_scope',
  settingsKey: 'migration_100_meshcore_channel_scope',
  sqlite: (db) => meshcoreChannelScopeMigration.up(db),
  postgres: (client) => runMeshcoreChannelScopePostgres(client),
  mysql: (pool) => runMeshcoreChannelScopeMysql(pool),
});

registry.register({
  number: 101,
  name: 'add_node_unmessagable',
  settingsKey: 'migration_101_add_node_unmessagable',
  sqlite: (db) => nodeUnmessagableMigration.up(db),
  postgres: (client) => runNodeUnmessagablePostgres(client),
  mysql: (pool) => runNodeUnmessagableMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 102: create meshcore_heard_repeaters (#3700). Per-source side
// table recording repeaters that re-flooded our outgoing channel messages,
// inferred by self-echo correlation on inbound GRP_TXT OTA packets.
// ---------------------------------------------------------------------------

registry.register({
  number: 102,
  name: 'create_meshcore_heard_repeaters',
  settingsKey: 'migration_102_create_meshcore_heard_repeaters',
  sqlite: (db) => meshcoreHeardRepeatersMigration.up(db),
  postgres: (client) => runMeshcoreHeardRepeatersPostgres(client),
  mysql: (pool) => runMeshcoreHeardRepeatersMysql(pool),
});

registry.register({
  number: 103,
  name: 'consolidate_mqtt_channels',
  settingsKey: 'migration_103_consolidate_mqtt_channels',
  sqlite: (db) => consolidateMqttChannelsMigration.up(db),
  postgres: (client) => runConsolidateMqttChannelsPostgres(client),
  mysql: (pool) => runConsolidateMqttChannelsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 104: add channel_hash to channel_database so MQTT channels are
// identified by (name, hash) — two same-name/different-key undecryptable
// channels stay distinct.
// ---------------------------------------------------------------------------

registry.register({
  number: 104,
  name: 'add_channel_database_hash',
  settingsKey: 'migration_104_add_channel_database_hash',
  sqlite: (db) => channelDatabaseHashMigration.up(db),
  postgres: (client) => runChannelDatabaseHashPostgres(client),
  mysql: (pool) => runChannelDatabaseHashMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 105: add hopCount + routePath to meshcore_messages so received
// MeshCore messages can show their hop count and relay route in the UI (#3742).
// ---------------------------------------------------------------------------

registry.register({
  number: 105,
  name: 'add_meshcore_message_route',
  settingsKey: 'migration_105_add_meshcore_message_route',
  sqlite: (db) => meshcoreMessageRouteMigration.up(db),
  postgres: (client) => runMeshcoreMessageRoutePostgres(client),
  mysql: (pool) => runMeshcoreMessageRouteMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 106: meshcore_messages scope columns
// MeshCore messages can show the scope/region they were sent with (#3742 Ph2).
// ---------------------------------------------------------------------------

registry.register({
  number: 106,
  name: 'add_meshcore_message_scope',
  settingsKey: 'migration_106_add_meshcore_message_scope',
  sqlite: (db) => meshcoreMessageScopeMigration.up(db),
  postgres: (client) => runMeshcoreMessageScopePostgres(client),
  mysql: (pool) => runMeshcoreMessageScopeMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 107: clear Null Island (0,0) node positions
// One-shot cleanup of bogus (0,0) GPS fixes stored before the #3763 ingestion
// filter; nulls latitude/longitude in nodes + meshcore_nodes.
// ---------------------------------------------------------------------------

registry.register({
  number: 107,
  name: 'clear_null_island_positions',
  settingsKey: 'migration_107_clear_null_island_positions',
  sqlite: (db) => clearNullIslandMigration.up(db),
  postgres: (client) => runClearNullIslandPostgres(client),
  mysql: (pool) => runClearNullIslandMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 108: MeshCore saved-regions catalog (#3770)
// Global (no sourceId) user-maintained list of MeshCore region names used to
// populate scope dropdowns (channel settings + per-message override).
// ---------------------------------------------------------------------------

registry.register({
  number: 108,
  name: 'meshcore_saved_regions',
  settingsKey: 'migration_108_meshcore_saved_regions',
  sqlite: (db) => meshcoreSavedRegionsMigration.up(db),
  postgres: (client) => runMeshcoreSavedRegionsPostgres(client),
  mysql: (pool) => runMeshcoreSavedRegionsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 109: clamp future-dated traceroute timestamps (#2768)
// Repairs traceroute rows whose `timestamp` (from a node's ahead device clock)
// is later than their `createdAt` server time, which rendered as a negative
// "last traced" age. One-shot; the ingest path now caps device time at now.
// ---------------------------------------------------------------------------

registry.register({
  number: 109,
  name: 'clamp_future_traceroute_timestamps',
  settingsKey: 'migration_109_clamp_future_traceroute_timestamps',
  sqlite: (db) => clampFutureTracerouteMigration.up(db),
  postgres: (client) => runClampFutureTraceroutePostgres(client),
  mysql: (pool) => runClampFutureTracerouteMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 110: MeshCore position-history table (#3852)
// One row per distinct GPS fix per MeshCore node (from adverts + the
// Cayenne-LPP telemetry poll). Backs the MeshCore map's movement-trail
// overlay; swept on a rolling retention window by
// meshcorePositionHistoryService.
// ---------------------------------------------------------------------------

registry.register({
  number: 110,
  name: 'add_meshcore_position_history',
  settingsKey: 'migration_110_add_meshcore_position_history',
  sqlite: (db) => meshcorePositionHistoryMigration.up(db),
  postgres: (client) => runMeshcorePositionHistoryPostgres(client),
  mysql: (pool) => runMeshcorePositionHistoryMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 111: `positionSource` marker on `meshcore_nodes` (#3908)
// Lets upsertNode distinguish a telemetry-derived GNSS fix from the static
// contact/advert position so the latter never clobbers an established
// telemetry fix (or the position-history trail it feeds).
// ---------------------------------------------------------------------------

registry.register({
  number: 111,
  name: 'meshcore_node_position_source',
  settingsKey: 'migration_111_meshcore_node_position_source',
  sqlite: (db) => meshcoreNodePositionSourceMigration.up(db),
  postgres: (client) => runMeshcoreNodePositionSourcePostgres(client),
  mysql: (pool) => runMeshcoreNodePositionSourceMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 112: free-text `notes` on `nodes` (#3921)
// Per-node MeshMonitor-local annotation editable from the node detail view,
// mirroring the official mobile clients' local notes field. Never synced to
// the mesh. Nullable; existing rows keep NULL.
// ---------------------------------------------------------------------------

registry.register({
  number: 112,
  name: 'add_notes_to_nodes',
  settingsKey: 'migration_112_add_notes_to_nodes',
  sqlite: (db) => nodeNotesMigration.up(db),
  postgres: (client) => runNodeNotesPostgres(client),
  mysql: (pool) => runNodeNotesMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 113: normalise bootstrap-only and name-case-drifted indexes
// (#3962 Phase 3.3 WP-A). Adds the 7 indexes that existed only in SQLite's
// createIndexes() bootstrap (never in any migration), and normalises the 3
// camelCase/lowercase name-case pairs to canonical lowercase on all installs.
// After this migration the schemaDrift allowlist shrinks from 15 → 2 entries.
// ---------------------------------------------------------------------------

registry.register({
  number: 113,
  name: 'add_bootstrap_only_indexes',
  settingsKey: 'migration_113_add_bootstrap_only_indexes',
  sqlite: (db) => bootstrapOnlyIndexesMigration.up(db),
  postgres: (client) => runBootstrapOnlyIndexesPostgres(client),
  mysql: (pool) => runBootstrapOnlyIndexesMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 114: MeshCore Auto-Pathfinding target allowlist (#4024)
// `meshcore_pathfinding_targets` — one row per selected contact publicKey per
// sourceId, backing the OR-union "specific contact" sub-filter for MeshCore
// Auto-Pathfinding target filtering. Always source-scoped (no legacy
// unscoped rows).
// ---------------------------------------------------------------------------

registry.register({
  number: 114,
  name: 'create_meshcore_pathfinding_targets',
  settingsKey: 'migration_114_create_meshcore_pathfinding_targets',
  sqlite: (db) => meshcorePathfindingTargetsMigration.up(db),
  postgres: (client) => runMeshcorePathfindingTargetsPostgres(client),
  mysql: (pool) => runMeshcorePathfindingTargetsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 115: Drop an inline (autoindex) single-column UNIQUE constraint
// on user_notification_preferences.user_id that migration 079 can't see
// (issue #4044, recurrence of #3324).
// ---------------------------------------------------------------------------

registry.register({
  number: 115,
  name: 'drop_inline_notif_prefs_user_id_unique',
  settingsKey: 'migration_115_drop_inline_notif_prefs_user_id_unique',
  sqlite: (db) => dropInlineNotifPrefsUserIdUniqueMigration.up(db),
  postgres: (client) => runDropInlineNotifPrefsUserIdUniquePostgres(client),
  mysql: (pool) => runDropInlineNotifPrefsUserIdUniqueMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 116: One-shot cleanup of pre-existing out-of-range node positions
// (e.g. MeshCore advert junk like lat 1853 / lng -1598) that predate the
// isBogusPosition ingestion guard and blow the map's fit-bounds out to nothing.
// ---------------------------------------------------------------------------

registry.register({
  number: 116,
  name: 'trim_out_of_range_node_positions',
  settingsKey: 'migration_116_trim_out_of_range_node_positions',
  sqlite: (db) => trimOutOfRangeNodePositionsMigration.up(db),
  postgres: (client) => runTrimOutOfRangeNodePositionsPostgres(client),
  mysql: (pool) => runTrimOutOfRangeNodePositionsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 117: Drop the retired `upgrade_history` table and delete the
// `autoUpgrade*` settings rows (Auto-Upgrade Retirement, v4.13).
// ---------------------------------------------------------------------------

registry.register({
  number: 117,
  name: 'drop_upgrade_history',
  settingsKey: 'migration_117_drop_upgrade_history',
  sqlite: (db) => dropUpgradeHistoryMigration.up(db),
  postgres: (client) => runDropUpgradeHistoryPostgres(client),
  mysql: (pool) => runDropUpgradeHistoryMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 118: Drop legacy CHECK (auth_provider IN ('local', 'oidc'))
// from SQLite `users` so proxy auth (#4119) can insert authProvider='proxy'.
// ---------------------------------------------------------------------------

registry.register({
  number: 118,
  name: 'drop_legacy_auth_provider_check',
  settingsKey: 'migration_118_drop_legacy_auth_provider_check',
  sqlite: (db) => dropLegacyAuthProviderCheckMigration.up(db),
  postgres: (client) => runDropLegacyAuthProviderCheckPostgres(client),
  mysql: (pool) => runDropLegacyAuthProviderCheckMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 119: Separate light/dark map tilesets while preserving customized
// legacy selections. Implements issue #4096.
// ---------------------------------------------------------------------------

registry.register({
  number: 119,
  name: 'add_theme_tilesets',
  settingsKey: 'migration_119_add_theme_tilesets',
  sqlite: (db) => themeTilesetsMigration.up(db),
  postgres: (client) => runThemeTilesetsPostgres(client),
  mysql: (pool) => runThemeTilesetsMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 120: Add `reason` column to `ignored_nodes` (MQTT Geo-Ignore
// epic, Phase 1) to distinguish manual blocklist entries from geo-fence
// auto-ignores.
// ---------------------------------------------------------------------------

registry.register({
  number: 120,
  name: 'add_reason_to_ignored_nodes',
  settingsKey: 'migration_120_add_reason_to_ignored_nodes',
  sqlite: (db) => addReasonToIgnoredNodesMigration.up(db),
  postgres: (client) => runAddReasonToIgnoredNodesPostgres(client),
  mysql: (pool) => runAddReasonToIgnoredNodesMysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 121: Create mqtt_packet_log table, powering the MQTT Packet
// Monitor (Phase 1). One row per gateway reception of an MQTT-bridged
// ServiceEnvelope; grouped/dedup view is built at query time.
// ---------------------------------------------------------------------------

registry.register({
  number: 121,
  name: 'mqtt_packet_log',
  settingsKey: 'migration_121_mqtt_packet_log',
  sqlite: (db) => mqttPacketLogMigration.up(db),
  postgres: (client) => runMigration121Postgres(client),
  mysql: (pool) => runMigration121Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 122: One-shot cleanup of `nodes` rows orphaned by a previously
// deleted source (issue #4137). DELETE /api/sources/:id now purges a
// source's node rows at delete time going forward — this sweeps rows left
// behind by every deletion that happened before that fix landed.
// ---------------------------------------------------------------------------

registry.register({
  number: 122,
  name: 'cleanup_orphaned_source_nodes',
  settingsKey: 'migration_122_cleanup_orphaned_source_nodes',
  sqlite: (db) => cleanupOrphanedSourceNodesMigration.up(db),
  postgres: (client) => runMigration122Postgres(client),
  mysql: (pool) => runMigration122Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 123: One-shot re-filing of pre-existing MQTT-sourced directed
// messages (TEXT_MESSAGE_APP addressed to a specific node) from their LoRa
// channel to channel -1, so they render in the DM view instead of as
// broadcasts — matching the TCP path and the #4152 ingestion fix.
// ---------------------------------------------------------------------------

registry.register({
  number: 123,
  name: 'fix_mqtt_directed_message_channel',
  settingsKey: 'migration_123_fix_mqtt_directed_message_channel',
  sqlite: (db) => fixMqttDirectedMessageChannelMigration.up(db),
  postgres: (client) => runMigration123Postgres(client),
  mysql: (pool) => runMigration123Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 124: Add `positionLocationSource` to `nodes` — persists the
// Meshtastic Position.location_source (manual / internal GPS / external GPS),
// which was decoded off the wire but dropped before storage (issue #4176).
// ---------------------------------------------------------------------------

registry.register({
  number: 124,
  name: 'add_position_location_source',
  settingsKey: 'migration_124_add_position_location_source',
  sqlite: (db) => addPositionLocationSourceMigration.up(db),
  postgres: (client) => runMigration124Postgres(client),
  mysql: (pool) => runMigration124Mysql(pool),
});

// Migration 125: Add `xeddsa_signed` to `packet_log` — persists the firmware
// 2.8 XEdDSA signature-verified flag per packet so the Packet Monitor can
// render a signature shield (#3923). NULL = unknown/pre-2.8.
registry.register({
  number: 125,
  name: 'add_xeddsa_signed_to_packet_log',
  settingsKey: 'migration_125_add_xeddsa_signed_to_packet_log',
  sqlite: (db) => addXeddsaSignedMigration.up(db),
  postgres: (client) => runMigration125Postgres(client),
  mysql: (pool) => runMigration125Mysql(pool),
});

// Migration 126: Add `transportFlags` bitmask to `nodes` (1=RF, 2=MQTT,
// 4=UDP). Accumulating bits replace the last-wins `transportMechanism` for map
// visibility, so an MQTT echo can no longer erase a node's RF reachability and
// hide it behind the default-off "Show MQTT" toggle (#4240).
registry.register({
  number: 126,
  name: 'add_transport_flags_to_nodes',
  settingsKey: 'migration_126_add_transport_flags_to_nodes',
  sqlite: (db) => addTransportFlagsMigration.up(db),
  postgres: (client) => runMigration126Postgres(client),
  mysql: (pool) => runMigration126Mysql(pool),
});

// ---------------------------------------------------------------------------
// Migration 127: Create atak_contacts table (ATAK/CoT Phase 2, issue #3691).
// One row per distinct ATAK EUD seen on a source, built from the PLI variant
// of a decoded TAKPacket; upserted in place on (uid, sourceId) as new PLI
// beacons arrive. Meshtastic-only — MeshCore has no ATAK format.
// ---------------------------------------------------------------------------

registry.register({
  number: 127,
  name: 'add_atak_contacts',
  settingsKey: 'migration_127_add_atak_contacts',
  sqlite: (db) => addAtakContactsMigration.up(db),
  postgres: (client) => runMigration127Postgres(client),
  mysql: (pool) => runMigration127Mysql(pool),
});
