/**
 * Repository Exports
 *
 * Central export point for all repository classes.
 */

export { BaseRepository, ALL_SOURCES } from './base.js';
export type { DrizzleDatabase, SQLiteDrizzle, PostgresDrizzle, SourceScope } from './base.js';
export { SettingsRepository } from './settings.js';
export { ChannelsRepository, type ChannelInput } from './channels.js';
export { NodesRepository, type NodesCacheHook } from './nodes.js';
export { MessagesRepository } from './messages.js';
export { TelemetryRepository } from './telemetry.js';
export { AuthRepository } from './auth.js';
export type {
  DbUser, CreateUserInput, UpdateUserInput,
  DbPermission, CreatePermissionInput,
  DbApiToken, CreateApiTokenInput,
  DbAuditLogEntry,
} from './auth.js';
export { TraceroutesRepository } from './traceroutes.js';
export { NeighborsRepository } from './neighbors.js';
export type { DirectNeighborStats } from './neighbors.js';
export { NotificationsRepository } from './notifications.js';
export type {
  DbPushSubscription,
  NotificationPreferences,
  PushSubscriptionInput,
} from './notifications.js';
export { PacketLogRepository } from './packetLog.js';
export type { PacketLogFilterOptions } from './packetLog.js';
export { KeyRepairRepository } from './keyRepair.js';
export { AutoTracerouteRepository } from './autoTraceroute.js';
export type { AutoTracerouteNode } from './autoTraceroute.js';
export { MeshcorePathfindingTargetsRepository } from './meshcorePathfindingTargets.js';
export { TimeSyncRepository } from './timeSync.js';
export { DistanceDeleteLogRepository } from './distanceDeleteLog.js';
export { MapPreferencesRepository } from './mapPreferences.js';
export { ThemesRepository } from './themes.js';
export { SolarEstimatesRepository } from './solarEstimates.js';
export type { SolarEstimate } from './solarEstimates.js';
export { NewsCacheRepository } from './newsCache.js';
export type { NewsCache, UserNewsStatus } from './newsCache.js';
export { BackupHistoryRepository } from './backupHistory.js';
export type { BackupHistory } from './backupHistory.js';
export { ChannelDatabaseRepository, type ChannelDatabaseInput, type ChannelDatabaseUpdate, type ChannelDatabasePermissionInput } from './channelDatabase.js';
export { IgnoredNodesRepository, type IgnoredNodeRecord } from './ignoredNodes.js';
export { MeshCoreRepository } from './meshcore.js';
export type { DbMeshCoreNode, DbMeshCoreMessage } from './meshcore.js';
export { EmbedProfileRepository } from './embedProfiles.js';
export type { EmbedProfile, EmbedProfileInput } from './embedProfiles.js';
export { AutomationsRepository } from './automations.js';
export type {
  AutomationRecord,
  CreateAutomationInput,
  UpdateAutomationInput,
  AutomationRunRecord,
  AutomationRunStatus,
  CreateAutomationRunInput,
} from './automations.js';
export { AutomationVariablesRepository } from './automationVariables.js';
export type {
  VariableType,
  VariableScope,
  AutomationVariableRecord,
  CreateVariableInput,
  UpdateVariableInput,
  AutomationVariableValueRecord,
} from './automationVariables.js';
export { SavedRegionsRepository, normalizeRegionName } from './savedRegions.js';
export type { SavedRegion } from './savedRegions.js';
export { SourcesRepository } from './sources.js';
export type { Source, CreateSourceInput } from './sources.js';
export { AnalysisRepository } from './analysis.js';
export type { PositionRow, PaginatedPositions, GetPositionsArgs } from './analysis.js';
export { WaypointsRepository } from './waypoints.js';
export type { Waypoint, WaypointUpsertInput, WaypointListOptions } from './waypoints.js';
export { EstimatedPositionsRepository } from './estimatedPositions.js';
export type { EstimatedPosition, EstimatedPositionInput } from './estimatedPositions.js';
export { AutoFavoriteTargetsRepository } from './autoFavoriteTargets.js';
export type { AutoFavoriteTargetInput } from './autoFavoriteTargets.js';
export { SourcePkiKeysRepository } from './sourcePkiKeys.js';
export type { DbSourcePkiKey } from './sourcePkiKeys.js';
export { DeadDropRepository } from './deadDrop.js';
export type { DeadDropMessageInput } from './deadDrop.js';
export { MqttPacketLogRepository } from './mqttPacketLog.js';
export type {
  DbMqttPacket,
  MqttIngestOutcome,
  MqttGroupedQuery,
  MqttGroupedPacket,
  MqttGateway,
} from './mqttPacketLog.js';
export { AtakContactsRepository } from './atakContacts.js';
export type { AtakContactRow } from './atakContacts.js';
