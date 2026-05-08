/**
 * Active Schema Map
 *
 * Resolves the correct dialect-specific Drizzle table objects once at construction time.
 * This eliminates the need for 3-way branching (if sqlite / else if mysql / else postgres)
 * in every repository method.
 *
 * Usage: const tables = buildActiveSchema(dbType);
 *        db.select().from(tables.nodes)...
 */
import { DatabaseType } from './types.js';

// Core tables
import {
  nodesSqlite, nodesPostgres, nodesMysql,
} from './schema/nodes.js';
import {
  messagesSqlite, messagesPostgres, messagesMysql,
} from './schema/messages.js';
import {
  channelsSqlite, channelsPostgres, channelsMysql,
} from './schema/channels.js';
import {
  telemetrySqlite, telemetryPostgres, telemetryMysql,
} from './schema/telemetry.js';
import {
  traceroutesSqlite, traceroutesPostgres, traceroutesMysql,
  routeSegmentsSqlite, routeSegmentsPostgres, routeSegmentsMysql,
} from './schema/traceroutes.js';
import {
  settingsSqlite, settingsPostgres, settingsMysql,
} from './schema/settings.js';
import {
  neighborInfoSqlite, neighborInfoPostgres, neighborInfoMysql,
} from './schema/neighbors.js';

// Auth tables
import {
  usersSqlite, usersPostgres, usersMysql,
  permissionsSqlite, permissionsPostgres, permissionsMysql,
  sessionsSqlite, sessionsPostgres, sessionsMysql,
  auditLogSqlite, auditLogPostgres, auditLogMysql,
  apiTokensSqlite, apiTokensPostgres, apiTokensMysql,
} from './schema/auth.js';

// Notification tables
import {
  pushSubscriptionsSqlite, pushSubscriptionsPostgres, pushSubscriptionsMysql,
  userNotificationPreferencesSqlite, userNotificationPreferencesPostgres, userNotificationPreferencesMysql,
  readMessagesSqlite, readMessagesPostgres, readMessagesMysql,
} from './schema/notifications.js';

// Packet logging
import {
  packetLogSqlite, packetLogPostgres, packetLogMysql,
} from './schema/packets.js';

// Miscellaneous tables
import {
  backupHistorySqlite, backupHistoryPostgres, backupHistoryMysql,
  systemBackupHistorySqlite, systemBackupHistoryPostgres, systemBackupHistoryMysql,
  customThemesSqlite, customThemesPostgres, customThemesMysql,
  userMapPreferencesSqlite, userMapPreferencesPostgres, userMapPreferencesMysql,
  upgradeHistorySqlite, upgradeHistoryPostgres, upgradeHistoryMysql,
  solarEstimatesSqlite, solarEstimatesPostgres, solarEstimatesMysql,
  autoTracerouteNodesSqlite, autoTracerouteNodesPostgres, autoTracerouteNodesMysql,
  autoTimeSyncNodesSqlite, autoTimeSyncNodesPostgres, autoTimeSyncNodesMysql,
  autoTracerouteLogSqlite, autoTracerouteLogPostgres, autoTracerouteLogMysql,
  autoKeyRepairStateSqlite, autoKeyRepairStatePostgres, autoKeyRepairStateMysql,
  autoKeyRepairLogSqlite, autoKeyRepairLogPostgres, autoKeyRepairLogMysql,
  autoDistanceDeleteLogSqlite, autoDistanceDeleteLogPostgres, autoDistanceDeleteLogMysql,
  geofenceCooldownsSqlite, geofenceCooldownsPostgres, geofenceCooldownsMysql,
  newsCacheSqlite, newsCachePostgres, newsCacheMysql,
  userNewsStatusSqlite, userNewsStatusPostgres, userNewsStatusMysql,
} from './schema/misc.js';

// Channel Database tables
import {
  channelDatabaseSqlite, channelDatabasePostgres, channelDatabaseMysql,
  channelDatabasePermissionsSqlite, channelDatabasePermissionsPostgres, channelDatabasePermissionsMysql,
} from './schema/channelDatabase.js';

// Ignored Nodes table
import {
  ignoredNodesSqlite, ignoredNodesPostgres, ignoredNodesMysql,
} from './schema/ignoredNodes.js';

// MeshCore tables
import {
  meshcoreNodesSqlite, meshcoreNodesPostgres, meshcoreNodesMysql,
} from './schema/meshcoreNodes.js';
import {
  meshcoreMessagesSqlite, meshcoreMessagesPostgres, meshcoreMessagesMysql,
} from './schema/meshcoreMessages.js';

// Embed Profiles table
import {
  embedProfilesSqlite, embedProfilesPostgres, embedProfilesMysql,
} from './schema/embedProfiles.js';

// Waypoints table
import {
  waypointsSqlite, waypointsPostgres, waypointsMysql,
} from './schema/waypoints.js';

// Sources table
import {
  sourcesSqlite, sourcesPostgres, sourcesMysql,
} from './schema/sources.js';

/**
 * Runtime table map interface.
 *
 * All properties are typed as `any` because Drizzle's dialect-specific table types
 * (SQLiteTableWithColumns, PgTableWithColumns, MySqlTableWithColumns) are incompatible
 * at compile time but structurally identical at runtime for query building.
 */
export interface ActiveSchema {
  // Core tables
  nodes: any;
  messages: any;
  channels: any;
  telemetry: any;
  traceroutes: any;
  routeSegments: any;
  settings: any;
  neighborInfo: any;

  // Auth tables
  users: any;
  permissions: any;
  sessions: any;
  auditLog: any;
  apiTokens: any;

  // Notification tables
  pushSubscriptions: any;
  userNotificationPreferences: any;
  readMessages: any;

  // Packet logging
  packetLog: any;

  // Miscellaneous tables
  backupHistory: any;
  systemBackupHistory: any;
  customThemes: any;
  userMapPreferences: any;
  upgradeHistory: any;
  solarEstimates: any;
  autoTracerouteNodes: any;
  autoTimeSyncNodes: any;
  autoTracerouteLog: any;
  autoKeyRepairState: any;
  autoKeyRepairLog: any;
  autoDistanceDeleteLog: any;
  geofenceCooldowns: any;
  newsCache: any;
  userNewsStatus: any;

  // Channel Database tables
  channelDatabase: any;
  channelDatabasePermissions: any;

  // Ignored Nodes
  ignoredNodes: any;

  // MeshCore tables
  meshcoreNodes: any;
  meshcoreMessages: any;

  // Embed Profiles
  embedProfiles: any;

  // Waypoints
  waypoints: any;

  // Sources
  sources: any;

  // Allow dynamic access for flexibility
  [key: string]: any;
}

/**
 * Static map of database type to dialect-specific table objects.
 */
const SCHEMA_MAP: Record<DatabaseType, ActiveSchema> = {
  sqlite: {
    nodes: nodesSqlite,
    messages: messagesSqlite,
    channels: channelsSqlite,
    telemetry: telemetrySqlite,
    traceroutes: traceroutesSqlite,
    routeSegments: routeSegmentsSqlite,
    settings: settingsSqlite,
    neighborInfo: neighborInfoSqlite,
    users: usersSqlite,
    permissions: permissionsSqlite,
    sessions: sessionsSqlite,
    auditLog: auditLogSqlite,
    apiTokens: apiTokensSqlite,
    pushSubscriptions: pushSubscriptionsSqlite,
    userNotificationPreferences: userNotificationPreferencesSqlite,
    readMessages: readMessagesSqlite,
    packetLog: packetLogSqlite,
    backupHistory: backupHistorySqlite,
    systemBackupHistory: systemBackupHistorySqlite,
    customThemes: customThemesSqlite,
    userMapPreferences: userMapPreferencesSqlite,
    upgradeHistory: upgradeHistorySqlite,
    solarEstimates: solarEstimatesSqlite,
    autoTracerouteNodes: autoTracerouteNodesSqlite,
    autoTimeSyncNodes: autoTimeSyncNodesSqlite,
    autoTracerouteLog: autoTracerouteLogSqlite,
    autoKeyRepairState: autoKeyRepairStateSqlite,
    autoKeyRepairLog: autoKeyRepairLogSqlite,
    autoDistanceDeleteLog: autoDistanceDeleteLogSqlite,
    geofenceCooldowns: geofenceCooldownsSqlite,
    newsCache: newsCacheSqlite,
    userNewsStatus: userNewsStatusSqlite,
    channelDatabase: channelDatabaseSqlite,
    channelDatabasePermissions: channelDatabasePermissionsSqlite,
    ignoredNodes: ignoredNodesSqlite,
    meshcoreNodes: meshcoreNodesSqlite,
    meshcoreMessages: meshcoreMessagesSqlite,
    embedProfiles: embedProfilesSqlite,
    waypoints: waypointsSqlite,
    sources: sourcesSqlite,
  },
  postgres: {
    nodes: nodesPostgres,
    messages: messagesPostgres,
    channels: channelsPostgres,
    telemetry: telemetryPostgres,
    traceroutes: traceroutesPostgres,
    routeSegments: routeSegmentsPostgres,
    settings: settingsPostgres,
    neighborInfo: neighborInfoPostgres,
    users: usersPostgres,
    permissions: permissionsPostgres,
    sessions: sessionsPostgres,
    auditLog: auditLogPostgres,
    apiTokens: apiTokensPostgres,
    pushSubscriptions: pushSubscriptionsPostgres,
    userNotificationPreferences: userNotificationPreferencesPostgres,
    readMessages: readMessagesPostgres,
    packetLog: packetLogPostgres,
    backupHistory: backupHistoryPostgres,
    systemBackupHistory: systemBackupHistoryPostgres,
    customThemes: customThemesPostgres,
    userMapPreferences: userMapPreferencesPostgres,
    upgradeHistory: upgradeHistoryPostgres,
    solarEstimates: solarEstimatesPostgres,
    autoTracerouteNodes: autoTracerouteNodesPostgres,
    autoTimeSyncNodes: autoTimeSyncNodesPostgres,
    autoTracerouteLog: autoTracerouteLogPostgres,
    autoKeyRepairState: autoKeyRepairStatePostgres,
    autoKeyRepairLog: autoKeyRepairLogPostgres,
    autoDistanceDeleteLog: autoDistanceDeleteLogPostgres,
    geofenceCooldowns: geofenceCooldownsPostgres,
    newsCache: newsCachePostgres,
    userNewsStatus: userNewsStatusPostgres,
    channelDatabase: channelDatabasePostgres,
    channelDatabasePermissions: channelDatabasePermissionsPostgres,
    ignoredNodes: ignoredNodesPostgres,
    meshcoreNodes: meshcoreNodesPostgres,
    meshcoreMessages: meshcoreMessagesPostgres,
    embedProfiles: embedProfilesPostgres,
    waypoints: waypointsPostgres,
    sources: sourcesPostgres,
  },
  mysql: {
    nodes: nodesMysql,
    messages: messagesMysql,
    channels: channelsMysql,
    telemetry: telemetryMysql,
    traceroutes: traceroutesMysql,
    routeSegments: routeSegmentsMysql,
    settings: settingsMysql,
    neighborInfo: neighborInfoMysql,
    users: usersMysql,
    permissions: permissionsMysql,
    sessions: sessionsMysql,
    auditLog: auditLogMysql,
    apiTokens: apiTokensMysql,
    pushSubscriptions: pushSubscriptionsMysql,
    userNotificationPreferences: userNotificationPreferencesMysql,
    readMessages: readMessagesMysql,
    packetLog: packetLogMysql,
    backupHistory: backupHistoryMysql,
    systemBackupHistory: systemBackupHistoryMysql,
    customThemes: customThemesMysql,
    userMapPreferences: userMapPreferencesMysql,
    upgradeHistory: upgradeHistoryMysql,
    solarEstimates: solarEstimatesMysql,
    autoTracerouteNodes: autoTracerouteNodesMysql,
    autoTimeSyncNodes: autoTimeSyncNodesMysql,
    autoTracerouteLog: autoTracerouteLogMysql,
    autoKeyRepairState: autoKeyRepairStateMysql,
    autoKeyRepairLog: autoKeyRepairLogMysql,
    autoDistanceDeleteLog: autoDistanceDeleteLogMysql,
    geofenceCooldowns: geofenceCooldownsMysql,
    newsCache: newsCacheMysql,
    userNewsStatus: userNewsStatusMysql,
    channelDatabase: channelDatabaseMysql,
    channelDatabasePermissions: channelDatabasePermissionsMysql,
    ignoredNodes: ignoredNodesMysql,
    meshcoreNodes: meshcoreNodesMysql,
    meshcoreMessages: meshcoreMessagesMysql,
    embedProfiles: embedProfilesMysql,
    waypoints: waypointsMysql,
    sources: sourcesMysql,
  },
};

/**
 * Build the active schema for a given database type.
 * Returns a frozen object mapping table group names to the correct dialect-specific table.
 */
export function buildActiveSchema(dbType: DatabaseType): ActiveSchema {
  const schema = SCHEMA_MAP[dbType];
  if (!schema) {
    throw new Error(`Unknown database type: ${dbType}`);
  }
  return Object.freeze({ ...schema });
}
