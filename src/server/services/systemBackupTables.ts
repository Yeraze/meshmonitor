/**
 * Which database tables a system backup holds.
 *
 * THE RULE: every table in the schema is named in exactly one of the two lists
 * below. `systemBackupTables.test.ts` builds the real schema on each backend
 * and fails when a table is in neither, so a new table cannot silently fall
 * outside the backup the way 52 of them had by the time of #5602's audit (a
 * restore of a MeshCore-only install brought back no nodes, no messages and no
 * automations).
 *
 * Adding a table:
 *   1. Put it in BACKUP_TABLES, after every table it has a foreign key to.
 *   2. If it holds a credential, key or token, also add it to
 *      BACKUP_SECRET_TABLES and say how the value is protected. A backup is
 *      already a secret (see docs/features/system-backup.md); the list is what
 *      keeps that statement honest.
 *   3. Only if the data must never leave the install, put it in
 *      BACKUP_EXCLUDED_TABLES with the reason. That is a security decision:
 *      the test pins the exclusion list, so changing it shows up in review.
 *
 * This module has no imports on purpose, so tests and the restore allowlist can
 * read the lists without opening a database.
 */

/**
 * Tables written to a backup, in RESTORE ORDER.
 *
 * Restore clears and refills each table in this order inside one transaction,
 * on every backend, whatever order the backup's own metadata lists them in. A
 * parent must come before its children for two reasons: the child's INSERT
 * needs the parent row to exist, and clearing a parent cascades into its
 * children (`ON DELETE CASCADE`), which would wipe a child restored earlier.
 *
 * The foreign keys that exist today all point at `sources`, `users` or
 * `channel_database`. The test reads them from the live schema, so a new
 * foreign key placed out of order fails there, not in a user's restore.
 */
export const BACKUP_TABLES: string[] = [
  // ── Roots: every foreign key in the schema leads here ────────────────────
  'sources',
  'users',

  // ── Core mesh data and settings (backed up since the first version) ──────
  'settings',
  'nodes',
  'channels',
  'messages',
  'telemetry',
  'traceroutes',
  'route_segments',
  'neighbor_info',
  'permissions',
  'audit_log',
  'read_messages',
  'user_notification_preferences',
  'auto_traceroute_nodes',
  'packet_log',
  'solar_estimates',
  'system_backup_history',
  // #2608: automated remote favorites management config + assignment ledger.
  'auto_favorite_targets',
  'auto_favorite_assignments',
  // #5156: operator-hosted privacy/terms/contact documents. Table-backed rather
  // than filesystem-backed precisely so they ride backup/restore — this list is
  // tables only, and directory-hosted assets are outside every backup.
  'privacy_documents',
  // #3195: operator's manual solar classification per physical node (global).
  'solar_node_overrides',
  // #5354: tracked-asset flags (global). The history they retain is valuable,
  // so the flag must survive a backup/restore.
  'asset_nodes',
  // #5277 P4b (U5): saved surveys — small, global metadata.
  'coverage_surveys',
  // #5277 P4b (U3): NOT a raw table dump — see FILTERED_EXPORTERS in
  // systemBackupService.ts. Only the receptions inside a saved survey's window
  // are exported, without `id`. Restore still clears the whole table first, so
  // non-survey receptions are lost on restore: they are regenerable.
  'coverage_receptions',
  // #5520: stored message translations. `translation_cache` (global, hashed
  // text only) before `message_translations` (per-source links into it).
  'translation_cache',
  'message_translations',
  // #5596: Analyzer Observer signing keys. See BACKUP_SECRET_TABLES.
  'meshcore_observer_keys',

  // ── Configuration and user state ─────────────────────────────────────────
  // Server-side channel decryption keys. See BACKUP_SECRET_TABLES. FK to users;
  // its permissions table FKs to both, so it follows.
  'channel_database',
  'channel_database_permissions',
  // #3653 Automation Engine: workflows, their variables and stored values, and
  // the home anchors the left-home trigger measures from.
  'automations',
  'automation_variables',
  'automation_variable_values',
  'automation_home_anchors',
  'custom_themes',
  'user_map_preferences',
  'embed_profiles',
  'waypoints',
  // #4750: which waypoint alerts were already sent. Without it a restore
  // re-notifies every waypoint.
  'waypoint_notifications',
  'ignored_nodes',
  'meshcore_ignored_nodes',
  'meshcore_message_filters',
  'meshcore_saved_regions',
  'meshcore_pathfinding_targets',
  'auto_time_sync_nodes',
  'conversation_read_state',
  'user_news_status',
  // #5032: the undo journal for node identity merges. Without it every past
  // merge becomes permanent.
  'node_identity_merges',
  'reticulum_interfaces',

  // ── MeshCore and Reticulum data ──────────────────────────────────────────
  // `meshcore_nodes` also holds saved repeater/room passwords. See
  // BACKUP_SECRET_TABLES.
  'meshcore_nodes',
  'meshcore_messages',
  'meshcore_neighbor_info',
  'meshcore_position_history',
  'meshcore_heard_repeaters',
  'reticulum_destinations',
  'reticulum_messages',
  'reticulum_paths',

  // ── Secrets ──────────────────────────────────────────────────────────────
  // All three are described in BACKUP_SECRET_TABLES.
  'api_tokens',
  'source_pki_keys',
  'meshcore_observer_credentials',

  // ── History, logs and derived data ───────────────────────────────────────
  // The large group. Everything here can be lost without breaking the install,
  // but none of it can be rebuilt once the packets are gone.
  'message_events',
  'meshtastic_heard_repeaters',
  'meshcore_packet_log',
  'mqtt_packet_log',
  'cross_source_links',
  'mqtt_ok_to_mqtt_violations',
  'atak_contacts',
  // Holds the user's dismissals: without it every declined invitation returns.
  'mesh_beacon_offers',
  'aircraft_flight_matches',
  'estimated_positions',
  'estimated_position_anchors',
  'mesh_issues',
  'dead_drop_messages',
  'automation_runs',
  'auto_traceroute_log',
  'auto_distance_delete_log',
  // Cooldown and last-run ledgers. Restoring them puts back the timestamps the
  // backup was made with, the same as the timers kept in `settings` always
  // have; leaving them out would start every cooldown from "never fired".
  'auto_key_repair_state',
  'auto_key_repair_log',
  // #5691 Reliable PKI: per-node exchange outcome and the hourly priming timer.
  'pki_exchange_state',
  'geofence_cooldowns',
  'news_cache',
];

/**
 * Tables that are deliberately NOT in a backup, with the reason.
 *
 * Changing this list changes what a stolen backup is worth, so it needs a
 * security review: the test pins it.
 */
export const BACKUP_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  // MM-SEC-1 footnote 1: per-subscriber push endpoint URLs and p256dh/auth
  // secrets. With a leaked VAPID private key these let an attacker push
  // arbitrary notifications to a subscriber's browser. Subscriptions are bound
  // to the browser and re-register on the next visit.
  push_subscriptions: 'push endpoint secrets; a stolen backup must not be a second-stage exploit (MM-SEC-1)',
  // Live session tokens: stealing a backup would be stealing every login.
  sessions: 'live session tokens; restoring them would also revive logged-out sessions',
  // Bookkeeping for device-config backup FILES on this install's disk. Those
  // files are not in a system backup, so the rows would point at nothing.
  backup_history: 'index of device-config backup files on this install, which are not in the backup',
};

/**
 * Backed-up tables that hold a key, credential or token, and what stands
 * between a reader of the backup file and the secret.
 *
 * `sessionSecret: true` marks values sealed with a key derived from
 * SESSION_SECRET. Restored on an install with a different SESSION_SECRET they
 * come back unreadable; restore keeps the rows and reports them
 * (systemRestoreService.findUnreadableSecrets).
 */
export const BACKUP_SECRET_TABLES: Readonly<Record<string, { protection: string; sessionSecret: boolean }>> = {
  users: { protection: 'password hashes (bcrypt); MFA secrets as stored', sessionSecret: false },
  api_tokens: { protection: 'bcrypt hash of each token; the token itself is never stored', sessionSecret: false },
  channels: { protection: 'NONE — channel PSKs in the clear', sessionSecret: false },
  channel_database: { protection: 'NONE — channel decryption PSKs in the clear', sessionSecret: false },
  mesh_beacon_offers: { protection: 'NONE — offered channel PSKs in the clear', sessionSecret: false },
  source_pki_keys: { protection: 'AES-256-GCM envelope keyed from SESSION_SECRET', sessionSecret: true },
  meshcore_observer_keys: { protection: 'AES-256-GCM envelope keyed from SESSION_SECRET', sessionSecret: true },
  meshcore_observer_credentials: { protection: 'AES-256-GCM envelope keyed from SESSION_SECRET', sessionSecret: true },
  meshcore_nodes: {
    protection: 'saved repeater/room passwords as AES-256-GCM envelopes keyed from SESSION_SECRET',
    sessionSecret: true,
  },
};

/** A plain SQL identifier. Table and column names read from a backup must match. */
export const BACKUP_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const BACKUP_TABLE_SET: ReadonlySet<string> = new Set(BACKUP_TABLES);

/**
 * Turn the table names read from a backup's `metadata.json` into the list to
 * restore.
 *
 * The names are attacker-controlled input if the backup file is: they end up
 * in SQL text and in file paths. Only names on the BACKUP_TABLES allowlist
 * survive, and they come back in BACKUP_TABLES order rather than the file's.
 * Anything else — a table this version does not know, a system table, an
 * injection-shaped string — lands in `skipped` and is never used.
 */
export function planRestoreTables(requested: unknown): { tables: string[]; skipped: string[] } {
  const names = Array.isArray(requested) ? requested : [];
  const wanted = new Set<string>();
  const skipped: string[] = [];
  for (const name of names) {
    if (typeof name === 'string' && BACKUP_TABLE_SET.has(name)) {
      wanted.add(name);
    } else {
      skipped.push(typeof name === 'string' ? name : String(name));
    }
  }
  return { tables: BACKUP_TABLES.filter((t) => wanted.has(t)), skipped };
}
