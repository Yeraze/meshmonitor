/**
 * Valid settings keys allowlist.
 *
 * This is the single source of truth for which settings can be saved via
 * POST /api/settings. Both server.ts and the persistence tests import
 * from here — add new settings to this list and they'll be accepted
 * everywhere automatically.
 */
export const VALID_SETTINGS_KEYS = [
  'maxNodeAgeHours',
  'tracerouteIntervalMinutes',
  'temperatureUnit',
  'distanceUnit',
  'positionHistoryLineStyle',
  'telemetryVisualizationHours',
  'telemetryFavorites',
  'telemetryCustomOrder',
  'dashboardWidgets',
  'dashboardSolarVisibility',
  'autoAckEnabled',
  'autoAckRegex',
  'autoAckMessage',
  'autoAckMessageDirect',
  'autoAckChannels',
  'autoAckDirectMessages',
  'autoAckUseDM',
  'autoAckSkipIncompleteNodes',
  'autoAckIgnoredNodes',
  'autoAckTapbackEnabled',
  'autoAckReplyEnabled',
  'autoAckDirectEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckMultihopReplyEnabled',
  'autoAckTestMessages',
  'autoAckCooldownSeconds',
  'customTapbackEmojis',
  'autoAnnounceEnabled',
  'autoAnnounceIntervalHours',
  'autoAnnounceMessage',
  'autoAnnounceChannelIndex',
  'autoAnnounceChannelIndexes',
  'autoAnnounceOnStart',
  'autoAnnounceUseSchedule',
  'autoAnnounceSchedule',
  'autoAnnounceNodeInfoEnabled',
  'autoAnnounceNodeInfoChannels',
  'autoAnnounceNodeInfoDelaySeconds',
  'autoWelcomeEnabled',
  'autoWelcomeMessage',
  'autoWelcomeTarget',
  'autoWelcomeWaitForName',
  'autoWelcomeMaxHops',
  'autoResponderEnabled',
  'autoResponderTriggers',
  'autoResponderSkipIncompleteNodes',
  'timerTriggers',
  'iconStyle',
  'preferredSortField',
  'preferredSortDirection',
  'preferredDashboardSortOption',
  'timeFormat',
  'dateFormat',
  'mapTileset',
  'packet_log_enabled',
  'packet_log_max_count',
  'packet_log_max_age_hours',
  'solarMonitoringEnabled',
  'solarMonitoringLatitude',
  'solarMonitoringLongitude',
  'solarMonitoringAzimuth',
  'solarMonitoringDeclination',
  'mapPinStyle',
  'favoriteTelemetryStorageDays',
  'theme',
  'customTilesets',
  'hideIncompleteNodes',
  'inactiveNodeThresholdHours',
  'inactiveNodeCheckIntervalMinutes',
  'inactiveNodeCooldownHours',
  'autoUpgradeImmediate',
  'autoUpgradeBlocked',
  'autoUpgradeBlockedReason',
  'maintenanceEnabled',
  'maintenanceTime',
  'messageRetentionDays',
  'tracerouteRetentionDays',
  'routeSegmentRetentionDays',
  'neighborInfoRetentionDays',
  'autoKeyManagementEnabled',
  'autoKeyManagementIntervalMinutes',
  'autoKeyManagementMaxExchanges',
  'autoKeyManagementAutoPurge',
  'autoKeyManagementImmediatePurge',
  'autoDeleteByDistanceEnabled',
  'autoDeleteByDistanceIntervalHours',
  'autoDeleteByDistanceThresholdKm',
  'autoDeleteByDistanceLat',
  'autoDeleteByDistanceLon',
  'autoDeleteByDistanceAction',
  'remoteAdminScannerIntervalMinutes',
  'remoteAdminScannerExpirationHours',
  'tracerouteScheduleEnabled',
  'tracerouteScheduleStart',
  'tracerouteScheduleEnd',
  'remoteAdminScheduleEnabled',
  'remoteAdminScheduleStart',
  'remoteAdminScheduleEnd',
  'geofenceTriggers',
  'autoPingEnabled',
  'autoPingIntervalSeconds',
  'autoPingMaxPings',
  'autoPingTimeoutSeconds',
  'autoFavoriteEnabled',
  'autoFavoriteStaleHours',
  'homoglyphEnabled',
  'localStatsIntervalMinutes',
  'nodeHopsCalculation',
  'nodeDimmingEnabled',
  'nodeDimmingStartHours',
  'nodeDimmingMinOpacity',
  'analyticsProvider',
  'analyticsConfig',
  'neighborInfoMinZoom',
  'defaultMapCenterLat',
  'defaultMapCenterLon',
  'defaultMapCenterZoom',
  'securityDigestEnabled',
  'securityDigestAppriseUrl',
  'securityDigestTime',
  'securityDigestReportType',
  'securityDigestSuppressEmpty',
  'securityDigestFormat',
  'activeMapStyleId',
  'telemetryWidgetModes',
  'telemetryWidgetRanges',
  'autoHeapManagementEnabled',
  'autoHeapManagementThresholdBytes',
  'tracerouteFilterLastHeardEnabled',
  'tracerouteFilterLastHeardHours',
  'tracerouteFilterHopsEnabled',
  'tracerouteFilterHopsMin',
  'tracerouteFilterHopsMax',
  'defaultLandingPage',
] as const;

export type ValidSettingKey = typeof VALID_SETTINGS_KEYS[number];

/**
 * Settings keys that are scoped per-source.
 *
 * These are read by per-source MeshtasticManager instances via
 * `databaseService.settings.getSettingForSource(this.sourceId, key)`. After
 * removing the global fallback (issue #2839), reads of these keys for a
 * source that has no per-source override return null — the caller's own
 * default kicks in, which is the correct behaviour for multi-source setups.
 *
 * The list is derived by grepping `getSettingForSource(...)` call sites in
 * the server. Update when adding a new per-source setting.
 *
 * Used by:
 *   - Migration 050 — promotes legacy global values into the default source's
 *     namespace on upgrade so single-source v3.x users don't lose config.
 *   - Future audit / lint rules that may want to assert that all per-source
 *     reads target a registered key.
 */
export const PER_SOURCE_SETTINGS_KEYS = [
  // Auto-ack
  'autoAckChannels',
  'autoAckCooldownSeconds',
  'autoAckDirectEnabled',
  'autoAckDirectMessages',
  'autoAckDirectReplyEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckEnabled',
  'autoAckIgnoredNodes',
  'autoAckMessage',
  'autoAckMessageDirect',
  'autoAckMultihopEnabled',
  'autoAckMultihopReplyEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckRegex',
  'autoAckSkipIncompleteNodes',
  'autoAckUseDM',
  // Auto-announce
  'autoAnnounceChannelIndexes',
  'autoAnnounceEnabled',
  'autoAnnounceIntervalHours',
  'autoAnnounceMessage',
  'autoAnnounceNodeInfoChannels',
  'autoAnnounceNodeInfoDelaySeconds',
  'autoAnnounceNodeInfoEnabled',
  'autoAnnounceOnStart',
  'autoAnnounceSchedule',
  'autoAnnounceUseSchedule',
  // Auto-delete by distance
  'autoDeleteByDistanceAction',
  'autoDeleteByDistanceEnabled',
  'autoDeleteByDistanceIntervalHours',
  'autoDeleteByDistanceLat',
  'autoDeleteByDistanceLon',
  'autoDeleteByDistanceThresholdKm',
  // Auto-favorite
  'autoFavoriteEnabled',
  'autoFavoriteNodes',
  'autoFavoriteStaleHours',
  // Auto-heap-management
  'autoHeapManagementEnabled',
  'autoHeapManagementThresholdBytes',
  // Auto-key-management
  'autoKeyManagementEnabled',
  // Auto-ping
  'autoPingEnabled',
  'autoPingIntervalSeconds',
  'autoPingMaxPings',
  'autoPingTimeoutSeconds',
  // Auto-responder (the feature the screenshots in #2839 call "Automations")
  'autoResponderEnabled',
  'autoResponderSkipIncompleteNodes',
  'autoResponderTriggers',
  // Auto-time-sync
  'autoTimeSyncEnabled',
  'autoTimeSyncIntervalMinutes',
  // Auto-welcome
  'autoWelcomeEnabled',
  'autoWelcomeMaxHops',
  'autoWelcomeMessage',
  'autoWelcomeTarget',
  'autoWelcomeWaitForName',
  // Misc per-source
  'externalUrl',
  'geofenceTriggers',
  'lastAnnouncementTime',
  'localNodeNum',
  'localStatsIntervalMinutes',
  'timerTriggers',
  // Remote admin
  'remoteAdminScannerIntervalMinutes',
  'remoteAdminScheduleEnabled',
  'remoteAdminScheduleEnd',
  'remoteAdminScheduleStart',
  // Security digest
  'securityDigestAppriseUrl',
  'securityDigestFormat',
  'securityDigestReportType',
  'securityDigestSuppressEmpty',
  // Traceroute scheduler / filters
  'tracerouteIntervalMinutes',
  'tracerouteScheduleEnabled',
  'tracerouteScheduleEnd',
  'tracerouteScheduleStart',
  'tracerouteNodeFilterEnabled',
  'tracerouteFilterChannels',
  'tracerouteFilterRoles',
  'tracerouteFilterHwModels',
  'tracerouteFilterNameRegex',
  'tracerouteFilterNodesEnabled',
  'tracerouteFilterChannelsEnabled',
  'tracerouteFilterRolesEnabled',
  'tracerouteFilterHwModelsEnabled',
  'tracerouteFilterRegexEnabled',
  'tracerouteExpirationHours',
  'tracerouteSortByHops',
  'tracerouteFilterLastHeardEnabled',
  'tracerouteFilterLastHeardHours',
  'tracerouteFilterHopsEnabled',
  'tracerouteFilterHopsMin',
  'tracerouteFilterHopsMax',
] as const;

export type PerSourceSettingKey = typeof PER_SOURCE_SETTINGS_KEYS[number];

/**
 * Settings keys whose values are secret and must never be returned to
 * non-admin callers from `GET /api/settings`. The plain VAPID public key
 * is intentionally NOT included — browsers need it to subscribe.
 *
 * Auto-generated VAPID material lives under `vapid_*` keys (see
 * `pushNotificationService`). Other historical keys live alongside the
 * regular allowlist (e.g. `securityDigestAppriseUrl`, `analyticsConfig`).
 */
export const SECRET_SETTINGS_KEYS = new Set<string>([
  'vapid_private_key',
  'securityDigestAppriseUrl',
  'analyticsConfig',
]);

/**
 * Tail-pattern denylist used in addition to the explicit set above so that
 * future secret-bearing keys are stripped by default. Anything matching
 * `*_private_key`, `*_secret`, or `*_token` (case-insensitive) is dropped.
 */
export const SECRET_SETTINGS_KEY_PATTERN = /(_private_key|_secret|_token)$/i;

/**
 * Strip secret-bearing keys from a settings map. Admins receive the
 * unmodified map; everyone else (including unauthenticated callers) gets
 * the secret keys removed.
 */
export function stripSecretSettings<T extends Record<string, unknown>>(
  settings: T,
  isAdmin: boolean
): Partial<T> {
  if (isAdmin) return settings;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_SETTINGS_KEYS.has(k)) continue;
    if (SECRET_SETTINGS_KEY_PATTERN.test(k)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
