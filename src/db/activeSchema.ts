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

// Per-user conversation read watermarks (issue #4607)
import {
  conversationReadStateSqlite, conversationReadStatePostgres, conversationReadStateMysql,
} from './schema/conversationReadState.js';

// Packet logging
import {
  packetLogSqlite, packetLogPostgres, packetLogMysql,
} from './schema/packets.js';
import {
  mqttPacketLogSqlite, mqttPacketLogPostgres, mqttPacketLogMysql,
} from './schema/mqttPacketLog.js';
import {
  mqttOkToMqttViolationsSqlite, mqttOkToMqttViolationsPostgres, mqttOkToMqttViolationsMysql,
} from './schema/mqttOkToMqttViolations.js';

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
import {
  automationHomeAnchorsSqlite, automationHomeAnchorsPostgres, automationHomeAnchorsMysql,
} from './schema/automationHomeAnchors.js';

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

// Per-estimate anchor rationale (global — no sourceId, issue #4609)
import {
  estimatedPositionAnchorsSqlite, estimatedPositionAnchorsPostgres, estimatedPositionAnchorsMysql,
} from './schema/estimatedPositionAnchors.js';

// Automated Remote Favorites Management (issue #2608)
import {
  autoFavoriteTargetsSqlite, autoFavoriteTargetsPostgres, autoFavoriteTargetsMysql,
  autoFavoriteAssignmentsSqlite, autoFavoriteAssignmentsPostgres, autoFavoriteAssignmentsMysql,
} from './schema/autoFavoriteTargets.js';
import {
  sourcePkiKeysSqlite, sourcePkiKeysPostgres, sourcePkiKeysMysql,
} from './schema/sourcePkiKeys.js';
import {
  meshcoreObserverKeysSqlite, meshcoreObserverKeysPostgres, meshcoreObserverKeysMysql,
} from './schema/meshcoreObserverKeys.js';
import {
  meshcoreObserverCredentialsSqlite, meshcoreObserverCredentialsPostgres, meshcoreObserverCredentialsMysql,
} from './schema/meshcoreObserverCredentials.js';
import {
  deadDropMessagesSqlite, deadDropMessagesPostgres, deadDropMessagesMysql,
} from './schema/deadDrop.js';

// ATAK contacts table (ATAK/CoT Phase 2, issue #3691)
import {
  atakContactsSqlite, atakContactsPostgres, atakContactsMysql,
} from './schema/atakContacts.js';

// Reticulum tables (epic #3960, Phase 1a)
import {
  reticulumDestinationsSqlite, reticulumDestinationsPostgres, reticulumDestinationsMysql,
  reticulumInterfacesSqlite, reticulumInterfacesPostgres, reticulumInterfacesMysql,
} from './schema/reticulum.js';

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

  // Per-user conversation read watermarks (issue #4607)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4607 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  conversationReadState: any;

  // Packet logging
  packetLog: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4124 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  mqttPacketLog: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4114 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  mqttOkToMqttViolations: any;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches ActiveSchema per-dialect table pattern
  automationHomeAnchors: any;

  // MeshCore saved-regions catalog (global — no sourceId) (#3770)
  meshcoreSavedRegions: any;

  // Waypoints
  waypoints: any;

  // Sources
  sources: any;

  // Estimated positions (global — no sourceId)
  estimatedPositions: any;

  // Per-estimate anchor rationale (global — no sourceId, issue #4609)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4609 every entry in this map is `any` by design (see the interface doc: the three dialect table types are incompatible at compile time, identical at runtime)
  estimatedPositionAnchors: any;

  // Automated Remote Favorites Management (issue #2608)
  autoFavoriteTargets: any;
  autoFavoriteAssignments: any;

  // Per-source PKI private keys for DM decryption (issue #3441)
  sourcePkiKeys: any;

  // Per-source MeshCore Analyzer Observer signing keys (epic #4457)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4457 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  meshcoreObserverKeys: any;

  // Per-source MeshCore Analyzer Observer static MQTT credentials (issue #4595)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #4595 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  meshcoreObserverCredentials: any;

  // Dead Drop / Mailbox — async per-source message store
  deadDropMessages: any;

  // ATAK contacts (ATAK/CoT Phase 2, issue #3691)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3691 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  atakContacts: any;

  // Reticulum tables (epic #3960, Phase 1a)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3960 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  reticulumDestinations: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3960 matches the existing ActiveSchema per-dialect table pattern; typing burn-down is #3962 Phase 6
  reticulumInterfaces: any;

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
    conversationReadState: conversationReadStateSqlite,
    packetLog: packetLogSqlite,
    mqttPacketLog: mqttPacketLogSqlite,
    mqttOkToMqttViolations: mqttOkToMqttViolationsSqlite,
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
    automationHomeAnchors: automationHomeAnchorsSqlite,
    meshcoreSavedRegions: meshcoreSavedRegionsSqlite,
    waypoints: waypointsSqlite,
    sources: sourcesSqlite,
    estimatedPositions: estimatedPositionsSqlite,
    estimatedPositionAnchors: estimatedPositionAnchorsSqlite,
    autoFavoriteTargets: autoFavoriteTargetsSqlite,
    autoFavoriteAssignments: autoFavoriteAssignmentsSqlite,
    sourcePkiKeys: sourcePkiKeysSqlite,
    meshcoreObserverKeys: meshcoreObserverKeysSqlite,
    meshcoreObserverCredentials: meshcoreObserverCredentialsSqlite,
    deadDropMessages: deadDropMessagesSqlite,
    atakContacts: atakContactsSqlite,
    reticulumDestinations: reticulumDestinationsSqlite,
    reticulumInterfaces: reticulumInterfacesSqlite,
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
    conversationReadState: conversationReadStatePostgres,
    packetLog: packetLogPostgres,
    mqttPacketLog: mqttPacketLogPostgres,
    mqttOkToMqttViolations: mqttOkToMqttViolationsPostgres,
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
    automationHomeAnchors: automationHomeAnchorsPostgres,
    meshcoreSavedRegions: meshcoreSavedRegionsPostgres,
    waypoints: waypointsPostgres,
    sources: sourcesPostgres,
    estimatedPositions: estimatedPositionsPostgres,
    estimatedPositionAnchors: estimatedPositionAnchorsPostgres,
    autoFavoriteTargets: autoFavoriteTargetsPostgres,
    autoFavoriteAssignments: autoFavoriteAssignmentsPostgres,
    sourcePkiKeys: sourcePkiKeysPostgres,
    meshcoreObserverKeys: meshcoreObserverKeysPostgres,
    meshcoreObserverCredentials: meshcoreObserverCredentialsPostgres,
    deadDropMessages: deadDropMessagesPostgres,
    atakContacts: atakContactsPostgres,
    reticulumDestinations: reticulumDestinationsPostgres,
    reticulumInterfaces: reticulumInterfacesPostgres,
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
    conversationReadState: conversationReadStateMysql,
    packetLog: packetLogMysql,
    mqttPacketLog: mqttPacketLogMysql,
    mqttOkToMqttViolations: mqttOkToMqttViolationsMysql,
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
    automationHomeAnchors: automationHomeAnchorsMysql,
    meshcoreSavedRegions: meshcoreSavedRegionsMysql,
    waypoints: waypointsMysql,
    sources: sourcesMysql,
    estimatedPositions: estimatedPositionsMysql,
    estimatedPositionAnchors: estimatedPositionAnchorsMysql,
    autoFavoriteTargets: autoFavoriteTargetsMysql,
    autoFavoriteAssignments: autoFavoriteAssignmentsMysql,
    sourcePkiKeys: sourcePkiKeysMysql,
    meshcoreObserverKeys: meshcoreObserverKeysMysql,
    meshcoreObserverCredentials: meshcoreObserverCredentialsMysql,
    deadDropMessages: deadDropMessagesMysql,
    atakContacts: atakContactsMysql,
    reticulumDestinations: reticulumDestinationsMysql,
    reticulumInterfaces: reticulumInterfacesMysql,
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
