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
import {
  mqttPacketLogSqlite, mqttPacketLogPostgres, mqttPacketLogMysql,
} from './schema/mqttPacketLog.js';

// Miscellaneous tables
import {
  backupHistorySqlite, backupHistoryPostgres, backupHistoryMysql,
  systemBackupHistorySqlite, systemBackupHistoryPostgres, systemBackupHistoryMysql,
  customThemesSqlite, customThemesPostgres, customThemesMysql,
  userMapPreferencesSqlite, userMapPreferencesPostgres, userMapPreferencesMysql,
  solarEstimatesSqlite, solarEstimatesPostgres, solarEstimatesMysql,
  autoTracerouteNodesSqlite, autoTracerouteNodesPostgres, autoTracerouteNodesMysql,
  meshcorePathfindingTargetsSqlite, meshcorePathfindingTargetsPostgres, meshcorePathfindingTargetsMysql,
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
import {
  meshcoreNeighborsSqlite, meshcoreNeighborsPostgres, meshcoreNeighborsMysql,
} from './schema/meshcoreNeighbors.js';
import {
  meshcorePacketLogSqlite, meshcorePacketLogPostgres, meshcorePacketLogMysql,
} from './schema/meshcorePacketLog.js';
import {
  meshcorePositionHistorySqlite, meshcorePositionHistoryPostgres, meshcorePositionHistoryMysql,
} from './schema/meshcorePositionHistory.js';
import {
  meshcoreHeardRepeatersSqlite, meshcoreHeardRepeatersPostgres, meshcoreHeardRepeatersMysql,
} from './schema/meshcoreHeardRepeaters.js';

// Embed Profiles table
import {
  embedProfilesSqlite, embedProfilesPostgres, embedProfilesMysql,
} from './schema/embedProfiles.js';
import {
  automationsSqlite, automationsPostgres, automationsMysql,
  automationRunsSqlite, automationRunsPostgres, automationRunsMysql,
} from './schema/automations.js';
import {
  automationVariablesSqlite, automationVariablesPostgres, automationVariablesMysql,
  automationVariableValuesSqlite, automationVariableValuesPostgres, automationVariableValuesMysql,
} from './schema/automationVariables.js';

// MeshCore saved-regions catalog (global — no sourceId) (#3770)
import {
  meshcoreSavedRegionsSqlite, meshcoreSavedRegionsPostgres, meshcoreSavedRegionsMysql,
} from './schema/savedRegions.js';

// Waypoints table
import {
  waypointsSqlite, waypointsPostgres, waypointsMysql,
} from './schema/waypoints.js';

// Sources table
import {
  sourcesSqlite, sourcesPostgres, sourcesMysql,
} from './schema/sources.js';

// Estimated positions table (global — no sourceId)
import {
  estimatedPositionsSqlite, estimatedPositionsPostgres, estimatedPositionsMysql,
} from './schema/estimatedPositions.js';

// Automated Remote Favorites Management (issue #2608)
import {
  autoFavoriteTargetsSqlite, autoFavoriteTargetsPostgres, autoFavoriteTargetsMysql,
  autoFavoriteAssignmentsSqlite, autoFavoriteAssignmentsPostgres, autoFavoriteAssignmentsMysql,
} from './schema/autoFavoriteTargets.js';
import {
  sourcePkiKeysSqlite, sourcePkiKeysPostgres, sourcePkiKeysMysql,
} from './schema/sourcePkiKeys.js';
import {
  deadDropMessagesSqlite, deadDropMessagesPostgres, deadDropMessagesMysql,
} from './schema/deadDrop.js';

// ATAK contacts table (ATAK/CoT Phase 2, issue #3691)
import {
  atakContactsSqlite, atakContactsPostgres, atakContactsMysql,
} from './schema/atakContacts.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4124 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  mqttPacketLog: any;

  // Miscellaneous tables
  backupHistory: any;
  systemBackupHistory: any;
  customThemes: any;
  userMapPreferences: any;
  solarEstimates: any;
  autoTracerouteNodes: any;
  // meshcorePathfindingTargets (#4024) is intentionally NOT declared here —
  // it is served by the `[key: string]: any` index signature below so this
  // file doesn't grow its no-explicit-any lint-baseline count. Accessed as
  // `this.tables.meshcorePathfindingTargets` from MeshcorePathfindingTargetsRepository.
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
  meshcoreNeighbors: any;
  meshcorePacketLog: any;
  meshcorePositionHistory: any;
  meshcoreHeardRepeaters: any;

  // Embed Profiles
  embedProfiles: any;

  // Automation Engine (global — no sourceId)
  automations: any;
  automationRuns: any;
  automationVariables: any;
  automationVariableValues: any;

  // MeshCore saved-regions catalog (global — no sourceId) (#3770)
  meshcoreSavedRegions: any;

  // Waypoints
  waypoints: any;

  // Sources
  sources: any;

  // Estimated positions (global — no sourceId)
  estimatedPositions: any;

  // Automated Remote Favorites Management (issue #2608)
  autoFavoriteTargets: any;
  autoFavoriteAssignments: any;

  // Per-source PKI private keys for DM decryption (issue #3441)
  sourcePkiKeys: any;

  // Dead Drop / Mailbox — async per-source message store
  deadDropMessages: any;

  // ATAK contacts (ATAK/CoT Phase 2, issue #3691)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  atakContacts: any;

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
    mqttPacketLog: mqttPacketLogSqlite,
    backupHistory: backupHistorySqlite,
    systemBackupHistory: systemBackupHistorySqlite,
    customThemes: customThemesSqlite,
    userMapPreferences: userMapPreferencesSqlite,
    solarEstimates: solarEstimatesSqlite,
    autoTracerouteNodes: autoTracerouteNodesSqlite,
    meshcorePathfindingTargets: meshcorePathfindingTargetsSqlite,
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
    meshcoreNeighbors: meshcoreNeighborsSqlite,
    meshcorePacketLog: meshcorePacketLogSqlite,
    meshcorePositionHistory: meshcorePositionHistorySqlite,
    meshcoreHeardRepeaters: meshcoreHeardRepeatersSqlite,
    embedProfiles: embedProfilesSqlite,
    automations: automationsSqlite,
    automationRuns: automationRunsSqlite,
    automationVariables: automationVariablesSqlite,
    automationVariableValues: automationVariableValuesSqlite,
    meshcoreSavedRegions: meshcoreSavedRegionsSqlite,
    waypoints: waypointsSqlite,
    sources: sourcesSqlite,
    estimatedPositions: estimatedPositionsSqlite,
    autoFavoriteTargets: autoFavoriteTargetsSqlite,
    autoFavoriteAssignments: autoFavoriteAssignmentsSqlite,
    sourcePkiKeys: sourcePkiKeysSqlite,
    deadDropMessages: deadDropMessagesSqlite,
    atakContacts: atakContactsSqlite,
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
    mqttPacketLog: mqttPacketLogPostgres,
    backupHistory: backupHistoryPostgres,
    systemBackupHistory: systemBackupHistoryPostgres,
    customThemes: customThemesPostgres,
    userMapPreferences: userMapPreferencesPostgres,
    solarEstimates: solarEstimatesPostgres,
    autoTracerouteNodes: autoTracerouteNodesPostgres,
    meshcorePathfindingTargets: meshcorePathfindingTargetsPostgres,
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
    meshcoreNeighbors: meshcoreNeighborsPostgres,
    meshcorePacketLog: meshcorePacketLogPostgres,
    meshcorePositionHistory: meshcorePositionHistoryPostgres,
    meshcoreHeardRepeaters: meshcoreHeardRepeatersPostgres,
    embedProfiles: embedProfilesPostgres,
    automations: automationsPostgres,
    automationRuns: automationRunsPostgres,
    automationVariables: automationVariablesPostgres,
    automationVariableValues: automationVariableValuesPostgres,
    meshcoreSavedRegions: meshcoreSavedRegionsPostgres,
    waypoints: waypointsPostgres,
    sources: sourcesPostgres,
    estimatedPositions: estimatedPositionsPostgres,
    autoFavoriteTargets: autoFavoriteTargetsPostgres,
    autoFavoriteAssignments: autoFavoriteAssignmentsPostgres,
    sourcePkiKeys: sourcePkiKeysPostgres,
    deadDropMessages: deadDropMessagesPostgres,
    atakContacts: atakContactsPostgres,
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
    mqttPacketLog: mqttPacketLogMysql,
    backupHistory: backupHistoryMysql,
    systemBackupHistory: systemBackupHistoryMysql,
    customThemes: customThemesMysql,
    userMapPreferences: userMapPreferencesMysql,
    solarEstimates: solarEstimatesMysql,
    autoTracerouteNodes: autoTracerouteNodesMysql,
    meshcorePathfindingTargets: meshcorePathfindingTargetsMysql,
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
    meshcoreNeighbors: meshcoreNeighborsMysql,
    meshcorePacketLog: meshcorePacketLogMysql,
    meshcorePositionHistory: meshcorePositionHistoryMysql,
    meshcoreHeardRepeaters: meshcoreHeardRepeatersMysql,
    embedProfiles: embedProfilesMysql,
    automations: automationsMysql,
    automationRuns: automationRunsMysql,
    automationVariables: automationVariablesMysql,
    automationVariableValues: automationVariableValuesMysql,
    meshcoreSavedRegions: meshcoreSavedRegionsMysql,
    waypoints: waypointsMysql,
    sources: sourcesMysql,
    estimatedPositions: estimatedPositionsMysql,
    autoFavoriteTargets: autoFavoriteTargetsMysql,
    autoFavoriteAssignments: autoFavoriteAssignmentsMysql,
    sourcePkiKeys: sourcePkiKeysMysql,
    deadDropMessages: deadDropMessagesMysql,
    atakContacts: atakContactsMysql,
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
