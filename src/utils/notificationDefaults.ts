/**
 * The built-in notification preferences: what a (user, source) pair gets until
 * the user saves settings for that source.
 *
 * This is the ONE definition. The preferences GET route answers with it, the
 * filter path (push, Apprise, desktop) decides with it, the repository fills
 * missing columns from it, and the Notifications tab starts from it. Before
 * this file there were four copies that disagreed (the route's, the tab's, the
 * repository's per-column fallbacks, and "no row = allow everything" in the
 * filter), so what the settings page showed was not what the server did.
 *
 * A source with no saved row never borrows another source's row: channel
 * numbers, keyword lists and node ids mean different things on each source.
 *
 * Changing a value here changes how many notifications every never-configured
 * (user, source) pair receives. Treat it as a policy change, not a refactor.
 */

export interface NotificationPreferenceDefaults {
  enableWebPush: boolean;
  enableApprise: boolean;
  enabledChannels: number[];
  enableDirectMessages: boolean;
  notifyOnEmoji: boolean;
  notifyOnMqtt: boolean;
  notifyOnNewNode: boolean;
  notifyOnTraceroute: boolean;
  notifyOnInactiveNode: boolean;
  notifyOnLowBattery: boolean;
  lowBatteryThreshold: number;
  lowBatteryVoltageThreshold: number;
  notifyOnServerEvents: boolean;
  notifyOnWaypoint: boolean;
  waypointRadiusKm: number;
  waypointCenterLat: number | null;
  waypointCenterLon: number | null;
  prefixWithNodeName: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
  appriseUrls: string[];
  mutedChannels: Array<{ channelId: number; muteUntil: number | null }>;
  mutedDMs: Array<{ nodeUuid: string; muteUntil: number | null }>;
  messageTitleTemplate: string | null;
  messageBodyTemplate: string | null;
}

/**
 * A fresh copy of the built-in defaults. A function, not a shared object, so
 * no caller can change the defaults by pushing onto one of the arrays.
 */
export function defaultNotificationPreferences(): NotificationPreferenceDefaults {
  return {
    // Service switches. Web Push still needs a browser subscription for the
    // source, and Apprise needs URLs, so neither sends on its own.
    enableWebPush: true,
    enableApprise: false,
    // No channel is enabled until the user picks some: channel numbers are
    // per source, so there is no list that is right for every source.
    enabledChannels: [],
    enableDirectMessages: true,
    notifyOnEmoji: true,
    notifyOnMqtt: true,
    // Off until the user asks: on a busy source these fire far more often
    // than messages, and "never configured" should mean direct messages only.
    notifyOnNewNode: false,
    notifyOnTraceroute: false,
    notifyOnInactiveNode: false,
    notifyOnLowBattery: false,
    lowBatteryThreshold: 20,
    lowBatteryVoltageThreshold: 3300,
    notifyOnServerEvents: false,
    notifyOnWaypoint: false,
    waypointRadiusKm: 10,
    waypointCenterLat: null,
    waypointCenterLon: null,
    prefixWithNodeName: false,
    monitoredNodes: [],
    // No keywords. An allow word beats "channel not enabled" and matches as
    // a substring (the old default `Hi` matched "this" and "which"), so a
    // default allow list notified for channels the user never picked.
    whitelist: [],
    blacklist: [],
    appriseUrls: [],
    mutedChannels: [],
    mutedDMs: [],
    // null = the built-in message-notification template (#5593).
    messageTitleTemplate: null,
    messageBodyTemplate: null,
  };
}
