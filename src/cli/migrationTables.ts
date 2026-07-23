/**
 * Table lists for the SQLite → PostgreSQL/MySQL migration CLI (migrate-db.ts).
 *
 * Extracted into a standalone module so migrationTables.test.ts can assert
 * these stay in sync with the Drizzle schema (issue #3337: TABLE_ORDER had
 * drifted — six 4.x tables were missing and one stale entry remained).
 */

// Table migration order (respects foreign key dependencies)
// Tables not in this list will be migrated at the end
export const TABLE_ORDER = [
  // 4.0 multi-source: sources MUST come first — every other data table either
  // FKs to it or carries a sourceId backfilled from the default source seeded
  // immediately after this table is migrated.
  'sources',
  // Core tables (no dependencies)
  'nodes',
  'channels',
  'settings',
  // Tables with node dependencies
  'messages',
  'telemetry',
  'neighbor_info',
  'traceroutes',
  'route_segments',
  // 4.0: ignored_nodes is per-source but has no FK to users.
  'ignored_nodes',
  // 4.x per-source data tables (no FK to users)
  'waypoints',
  'embed_profiles',
  'geofence_cooldowns',
  // MeshCore tables — nodes must precede messages/neighbors/packet log
  'meshcore_nodes',
  'meshcore_messages',
  'meshcore_neighbor_info',
  'meshcore_packet_log',
  'meshcore_position_history',
  'meshcore_heard_repeaters',
  // Auth tables (must come before channel_database — channel_database
  // FKs to users for createdBy and channel_database_permissions FKs to users
  // for userId/grantedBy).
  'users',
  'permissions',
  'sessions',
  'audit_log',
  'api_tokens',
  // 4.0 per-source tables that depend on users
  'channel_database',
  'channel_database_permissions',
  // Notification tables
  'push_subscriptions',
  'user_notification_preferences',
  // Misc tables
  'read_messages',
  'news_cache',
  // user_news_status FKs to users (already migrated above)
  'user_news_status',
  'packet_log',
  // 4124: MQTT packet monitor reception log (per-gateway rows; sourceId, no FKs)
  'mqtt_packet_log',
  // 3691 Phase 2: per-source ATAK contact state (composite PK uid+sourceId, no FKs)
  'atak_contacts',
  'backup_history',
  'custom_themes',
  'user_map_preferences',
  'auto_traceroute_log',
  'auto_traceroute_nodes',
  'auto_time_sync_nodes',
  'auto_distance_delete_log',
  'auto_key_repair_state',
  'auto_key_repair_log',
  'solar_estimates',
  'system_backup_history',
  // 3271: global estimated positions (no sourceId, no FK — one row per nodeNum)
  'estimated_positions',
  // 2608: per-source automated remote favorites management config + ledger
  'auto_favorite_targets',
  'auto_favorite_assignments',
  // 3441: per-source encrypted X25519 private key for PKI DM decryption
  'source_pki_keys',
  // per-source async message store (Dead Drop / Mailbox)
  'dead_drop_messages',
  // 3653: global Automation Engine tables. No sourceId / no FK to users; the
  // run-log FKs to automations and variable values FK to automation_variables,
  // so parents precede children here.
  'automations',
  'automation_runs',
  'automation_variables',
  'automation_variable_values',
  // 3770: global MeshCore saved-regions catalog. No sourceId / no FK.
  'meshcore_saved_regions',
];

// Tables in the 4.0 schema that carry a `sourceId` column. When the source
// SQLite database is pre-4.0 the rows arrive without this column; we backfill
// it with the target's default source so the NOT NULL / FK constraints (e.g.
// nodes' composite PK) are satisfied. The `nodes` table is the strict-NOT-NULL
// case; the others tolerate NULL but populating them keeps source-scoped views
// working immediately on first boot.
export const SOURCE_SCOPED_TABLES = new Set([
  'nodes', 'messages', 'telemetry', 'traceroutes', 'route_segments',
  'channels', 'neighbor_info', 'packet_log', 'ignored_nodes', 'channel_database',
  'channel_database_permissions', 'push_subscriptions', 'user_notification_preferences',
  'auto_distance_delete_log', 'auto_key_repair_log', 'auto_time_sync_nodes',
  // 4.x-only tables: source rows always carry their own sourceId (the tables
  // didn't exist pre-4.0), so the backfill below is purely defensive.
  // NOTE: waypoints is source-scoped too but uses snake_case `source_id` in
  // every backend, so the `sourceId` backfill check never applies to it.
  'embed_profiles', 'meshcore_nodes', 'meshcore_messages',
  'meshcore_neighbor_info', 'meshcore_packet_log',
  'meshcore_heard_repeaters', 'mqtt_packet_log', 'atak_contacts',
  'auto_favorite_targets', 'auto_favorite_assignments',
  'dead_drop_messages',
]);

// Tables to skip entirely during migration (incompatible schemas or non-essential)
export const SKIP_TABLES = new Set([
  'packet_log', // Debug logging - schema incompatible and data is transient
  'sqlite_sequence', // SQLite internal table
  'backup_history', // Schema mismatch - null filePath values
  'auto_traceroute_log', // Non-essential logging
  'auto_traceroute_nodes', // Non-essential
  'meshcore_pathfinding_targets', // Non-essential (re-selectable Auto-Pathfinding allowlist, mirrors auto_traceroute_nodes)
  'auto_key_repair_state', // Non-essential
  'auto_key_repair_log', // Non-essential logging
  // solar_estimates - REMOVED: Users want historical solar data preserved
  'system_backup_history', // Non-essential
  'user_map_preferences', // Column mapping issues
]);
