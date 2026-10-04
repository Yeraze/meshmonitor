import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { defaultNotificationPreferences } from '../../utils/notificationDefaults.js';
import {
  renderMessageNotification,
  type MessageTemplateContext,
} from '../../utils/notificationTemplate.js';

export interface NotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
  viaMqtt?: boolean;
  /** For DMs: the UUID of the remote node. Used for per-DM mute checks. */
  nodeUuid?: string;
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name for body/title prefixing. */
  sourceName: string;
}

export interface MutedChannel {
  channelId: number;
  muteUntil: number | null;
}

export interface MutedDM {
  nodeUuid: string;
  muteUntil: number | null;
}

export interface NotificationPreferences {
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
  /** Waypoint arrival alerts (#4750) — see the repository's mirror of this type. */
  notifyOnWaypoint: boolean;
  waypointRadiusKm: number;
  waypointCenterLat: number | null;
  waypointCenterLon: number | null;
  prefixWithNodeName: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
  appriseUrls: string[];
  mutedChannels: MutedChannel[];
  mutedDMs: MutedDM[];
  /** Message-notification templates (#5593). NULL = the built-in default. */
  messageTitleTemplate: string | null;
  messageBodyTemplate: string | null;
}

/**
 * Check whether a mute rule is currently active.
 * A rule with muteUntil = null is active indefinitely.
 * A rule with muteUntil = timestamp is active until that time has passed.
 */
function isMuteActive(muteUntil: number | null): boolean {
  return muteUntil === null || muteUntil > Date.now();
}

/**
 * Check if a message contains only emojis (including emoji reactions and tapbacks)
 * Matches single emoji or emoji sequences with optional whitespace
 */
function isEmojiOnlyMessage(text: string): boolean {
  // Trim whitespace from the message
  const trimmed = text.trim();

  // Empty message is not considered emoji-only
  if (trimmed.length === 0) {
    return false;
  }

  // Regex pattern to match emoji Unicode ranges and common emoji sequences
  // This includes:
  // - Standard emoji ranges (U+1F300-U+1F9FF)
  // - Emoticons and symbols (U+2600-U+26FF)
  // - Dingbats (U+2700-U+27BF)
  // - Miscellaneous Symbols and Pictographs (U+1F900-U+1F9FF)
  // - Supplemental Symbols and Pictographs (U+1F300-U+1FAD6)
  // - Emoji modifiers (U+1F3FB-U+1F3FF)
  const emojiRegex = /^[\u{1F300}-\u{1FAD6}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\s]+$/u;

  return emojiRegex.test(trimmed);
}

/**
 * Source types whose channel numbering and node ids are NOT Meshtastic's.
 * Mute lists on the legacy '' row were set from the Meshtastic Channels tab,
 * so they never carry to a source of one of these types (#5487).
 */
export const NON_MESHTASTIC_SOURCE_TYPES: ReadonlySet<string> = new Set(['meshcore', 'meshcore_mqtt', 'reticulum']);

/**
 * The built-in preferences: what a (user, source) pair gets until the user
 * saves settings for that source. One definition for the whole app — see
 * src/utils/notificationDefaults.ts.
 */
export function getDefaultNotificationPreferences(): NotificationPreferences {
  return defaultNotificationPreferences();
}

/** Where a resolved set of preferences came from. */
export interface ResolvedNotificationPreferences {
  prefs: NotificationPreferences;
  /**
   * - `row`: the user's saved row for exactly this source.
   * - `legacyBlob`: the pre-4.0 `push_prefs_<userId>` settings blob.
   * - `default`: nothing saved; the built-in defaults.
   */
  origin: 'row' | 'legacyBlob' | 'default';
  /** The mute lists include rules carried from the user's legacy '' row. */
  legacyMutes: boolean;
}

/**
 * Read the pre-4.0 per-user settings blob, if the user still has one.
 *
 * This is the one real "global" preference record left from before
 * multi-source: `push_prefs_<userId>` in the settings table, written by 3.x and
 * never written since. Migration 028 deleted the per-source rows that predated
 * the per-source schema, so a user who has not saved preferences in 4.0+ has
 * only this. It is the user's own record, not another source's row, so it
 * still answers for a source with no row. Hardcoding the notify* toggles to
 * `true` here once re-enabled categories the user had turned off (#2867), so
 * every saved value is respected and only an absent field reads as the default.
 */
async function readLegacyPreferencesBlobAsync(userId: number): Promise<NotificationPreferences | null> {
  try {
    const prefsJson = await databaseService.getSettingAsync(`push_prefs_${userId}`);
    if (!prefsJson) return null;
    const oldPrefs = JSON.parse(prefsJson);
    if (!oldPrefs || typeof oldPrefs !== 'object') return null;
    const d = defaultNotificationPreferences();
    const boolOr = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback;
    const numOr = (value: unknown, fallback: number): number =>
      typeof value === 'number' ? value : fallback;
    return {
      enableWebPush: boolOr(oldPrefs.enableWebPush, d.enableWebPush),
      enableApprise: boolOr(oldPrefs.enableApprise, d.enableApprise),
      enabledChannels: oldPrefs.enabledChannels || [],
      enableDirectMessages: boolOr(oldPrefs.enableDirectMessages, d.enableDirectMessages),
      notifyOnEmoji: boolOr(oldPrefs.notifyOnEmoji, d.notifyOnEmoji),
      notifyOnMqtt: boolOr(oldPrefs.notifyOnMqtt, d.notifyOnMqtt),
      notifyOnNewNode: boolOr(oldPrefs.notifyOnNewNode, d.notifyOnNewNode),
      notifyOnTraceroute: boolOr(oldPrefs.notifyOnTraceroute, d.notifyOnTraceroute),
      notifyOnInactiveNode: boolOr(oldPrefs.notifyOnInactiveNode, d.notifyOnInactiveNode),
      notifyOnLowBattery: boolOr(oldPrefs.notifyOnLowBattery, d.notifyOnLowBattery),
      // Waypoint alerts postdate the legacy blob entirely, so there is
      // nothing to read back — they are off until the user opts in (#4750).
      notifyOnWaypoint: boolOr(oldPrefs.notifyOnWaypoint, d.notifyOnWaypoint),
      waypointRadiusKm: numOr(oldPrefs.waypointRadiusKm, d.waypointRadiusKm),
      waypointCenterLat: typeof oldPrefs.waypointCenterLat === 'number' ? oldPrefs.waypointCenterLat : null,
      waypointCenterLon: typeof oldPrefs.waypointCenterLon === 'number' ? oldPrefs.waypointCenterLon : null,
      lowBatteryThreshold: numOr(oldPrefs.lowBatteryThreshold, d.lowBatteryThreshold),
      lowBatteryVoltageThreshold: numOr(oldPrefs.lowBatteryVoltageThreshold, d.lowBatteryVoltageThreshold),
      notifyOnServerEvents: boolOr(oldPrefs.notifyOnServerEvents, d.notifyOnServerEvents),
      prefixWithNodeName: boolOr(oldPrefs.prefixWithNodeName, d.prefixWithNodeName),
      monitoredNodes: oldPrefs.monitoredNodes || [],
      // The blob predates the default keyword lists; an absent list is empty.
      whitelist: oldPrefs.whitelist || [],
      blacklist: oldPrefs.blacklist || [],
      appriseUrls: oldPrefs.appriseUrls || [],
      mutedChannels: oldPrefs.mutedChannels || [],
      mutedDMs: oldPrefs.mutedDMs || [],
      // Templates postdate the legacy blob (#5593): always the default.
      messageTitleTemplate: null,
      messageBodyTemplate: null,
    };
  } catch (error) {
    logger.error(`Failed to read legacy preferences blob for user ${userId}:`, error);
    return null;
  }
}

/** Union two mute lists by key; where both mute the same key, `extra` wins. */
function unionMutes<T extends { muteUntil: number | null }>(base: T[], extra: T[], key: (r: T) => string | number): T[] {
  const extraKeys = new Set(extra.map(key));
  return [...base.filter(r => !extraKeys.has(key(r))), ...extra];
}

/**
 * The ACTIVE mute rules on the user's legacy '' row, when they apply to
 * `sourceId`; null when there are none or the source is not Meshtastic.
 *
 * The '' row is not a source's row. Before #5487 the Channels tab saved every
 * mute without a source id, so mutes landed there, and migration 186 left them
 * there for any source that had no row of its own ("its mutes are already in
 * force there"). They are the one thing that still carries from the '' row to
 * a never-configured source. Nothing else on that row does: its other fields
 * were filled in by the old leaky read and are a stale copy of some other
 * source's settings. A mute can only silence, so carrying it cannot add a
 * notification.
 */
async function readLegacyMutesAsync(
  userId: number,
  sourceId: string,
): Promise<{ mutedChannels: MutedChannel[]; mutedDMs: MutedDM[] } | null> {
  const legacyRow = await databaseService.notifications.getUserPreferences(userId, '');
  if (!legacyRow) return null;
  const mutedChannels = (legacyRow.mutedChannels ?? []).filter(r => isMuteActive(r.muteUntil));
  const mutedDMs = (legacyRow.mutedDMs ?? []).filter(r => isMuteActive(r.muteUntil));
  if (mutedChannels.length === 0 && mutedDMs.length === 0) return null;

  // Only a known Meshtastic-numbered source takes them: the rules are keyed by
  // Meshtastic channel number, which is an unrelated channel on MeshCore.
  try {
    const source = await databaseService.sources.getSource(sourceId);
    if (!source || NON_MESHTASTIC_SOURCE_TYPES.has(source.type)) return null;
  } catch (error) {
    logger.debug(`Could not resolve source ${sourceId} for legacy mutes:`, error);
    return null;
  }
  return { mutedChannels, mutedDMs };
}

/**
 * Resolve the preferences in force for (userId, sourceId), and say where they
 * came from.
 *
 * Order:
 * 1. The saved row for EXACTLY this source.
 * 2. The pre-4.0 per-user settings blob, if the user still has one.
 * 3. The built-in defaults.
 *
 * A source the user never configured does NOT borrow another source's row.
 * Until this change it did: a miss fell back to `getUserPreferences(userId, '')`
 * (#4020), and with an empty source id the repository dropped the source
 * filter and returned the user's first row of any source. Source B then used
 * the channel numbers, keyword lists and toggles saved for source A.
 *
 * For steps 2 and 3 only, a Meshtastic source also takes the active mute rules
 * from the user's legacy '' row (see `readLegacyMutesAsync`).
 *
 * `sourceId` omitted or '' (a caller with no source in hand, or the unsourced
 * view) reads the '' row itself, then steps 2 and 3.
 *
 * Returns null only for an invalid userId. A failed row read is logged by the
 * repository and resolves as "no row".
 */
export async function resolveNotificationPreferencesAsync(
  userId: number,
  sourceId?: string,
): Promise<ResolvedNotificationPreferences | null> {
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return null;
  }
  const scopedSourceId = sourceId || '';

  try {
    const row = await databaseService.notifications.getUserPreferences(userId, scopedSourceId);
    if (row) {
      return { prefs: row, origin: 'row', legacyMutes: false };
    }

    const blob = await readLegacyPreferencesBlobAsync(userId);
    const base: NotificationPreferences = blob ?? defaultNotificationPreferences();
    const origin = blob ? 'legacyBlob' : 'default';

    if (scopedSourceId === '') {
      return { prefs: base, origin, legacyMutes: false };
    }

    const legacy = await readLegacyMutesAsync(userId, scopedSourceId);
    if (!legacy) {
      return { prefs: base, origin, legacyMutes: false };
    }
    return {
      prefs: {
        ...base,
        mutedChannels: unionMutes(base.mutedChannels ?? [], legacy.mutedChannels, r => r.channelId),
        mutedDMs: unionMutes(base.mutedDMs ?? [], legacy.mutedDMs, r => r.nodeUuid),
      },
      origin,
      legacyMutes: true,
    };
  } catch (error) {
    // Defaults, not "allow everything": a failed read must not open the gate.
    logger.error(`Failed to load preferences for user ${userId}:`, error);
    return { prefs: defaultNotificationPreferences(), origin: 'default', legacyMutes: false };
  }
}

/**
 * The preferences in force for (userId, sourceId): the saved row for that
 * source, else the built-in defaults. Never another source's row. See
 * `resolveNotificationPreferencesAsync` for the full order.
 *
 * Returns null only for an invalid userId.
 */
export async function getUserNotificationPreferencesAsync(userId: number, sourceId?: string): Promise<NotificationPreferences | null> {
  const resolved = await resolveNotificationPreferencesAsync(userId, sourceId);
  return resolved ? resolved.prefs : null;
}

/**
 * Save notification preferences for a user to the database
 * Uses the notifications repository for database-agnostic queries
 */
export async function saveUserNotificationPreferencesAsync(
  userId: number,
  preferences: NotificationPreferences,
  sourceId?: string
): Promise<boolean> {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return false;
  }

  try {
    return await databaseService.notifications.saveUserPreferences(userId, preferences, sourceId);
  } catch (error) {
    logger.error(`Failed to save preferences for user ${userId}:`, error);
    return false;
  }
}

/**
 * Get users who have a specific notification service enabled
 */
export async function getUsersWithServiceEnabledAsync(service: 'web_push' | 'apprise'): Promise<number[]> {
  try {
    return databaseService.notifications.getUsersWithServiceEnabled(service);
  } catch (error) {
    logger.debug('No user_notification_preferences table yet, returning empty array');
    return [];
  }
}

/**
 * Check if a notification should be filtered for a specific user
 *
 * Filtering logic (priority order):
 * 1. WHITELIST - If message contains whitelisted word, ALLOW (highest priority)
 * 2. BLACKLIST - If message contains blacklisted word, FILTER
 * 3. EMOJI - If notifyOnEmoji is disabled and message is emoji-only, FILTER
 * 4. MQTT - If notifyOnMqtt is disabled and message came via MQTT, FILTER
 * 5. CHANNEL/DM - If channel/DM is disabled, FILTER
 * 6. DEFAULT - ALLOW
 */
export async function shouldFilterNotificationAsync(
  userId: number,
  filterContext: NotificationFilterContext
): Promise<boolean> {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return false; // Allow on validation error (fail-open for UX)
  }

  // Phase B: permission check — user must have messages:read on this source
  try {
    const allowed = await databaseService.checkPermissionAsync(userId, 'messages', 'read', filterContext.sourceId);
    if (!allowed) {
      logger.debug(`🔒 User ${userId} lacks messages:read on source ${filterContext.sourceId}, filtering`);
      return true;
    }
  } catch (error) {
    logger.error(`Failed permission check for user ${userId} on source ${filterContext.sourceId}:`, error);
    return true; // Fail-closed on permission errors to avoid leaking cross-source data
  }

  // Load user preferences for THIS source: its saved row, else the built-in
  // defaults. A user with no row used to pass every message here ("no
  // preferences = allow"), which disagreed with the defaults the settings page
  // showed; both now read one definition.
  const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
  if (!prefs) {
    return false; // Unreachable: only an invalid userId resolves to null, and that returned above.
  }

  const messageTextLower = filterContext.messageText.toLowerCase();

  // WHITELIST (highest priority — overrides mutes)
  for (const word of prefs.whitelist) {
    if (word && messageTextLower.includes(word.toLowerCase())) {
      logger.debug(`✅ Whitelist match for user ${userId}: "${word}"`);
      return false; // Don't filter
    }
  }

  // MUTE CHECK (second priority — per-channel and per-DM mutes)
  if (filterContext.isDirectMessage && filterContext.nodeUuid) {
    const dmRule = (prefs.mutedDMs ?? []).find(r => r.nodeUuid === filterContext.nodeUuid);
    if (dmRule && isMuteActive(dmRule.muteUntil)) {
      logger.debug(`🔇 DM from ${filterContext.nodeUuid} muted for user ${userId}`);
      return true; // Filter
    }
  } else if (!filterContext.isDirectMessage) {
    const channelRule = (prefs.mutedChannels ?? []).find(r => r.channelId === filterContext.channelId);
    if (channelRule && isMuteActive(channelRule.muteUntil)) {
      logger.debug(`🔇 Channel ${filterContext.channelId} muted for user ${userId}`);
      return true; // Filter
    }
  }

  // BLACKLIST (third priority)
  for (const word of prefs.blacklist) {
    if (word && messageTextLower.includes(word.toLowerCase())) {
      logger.debug(`🚫 Blacklist match for user ${userId}: "${word}"`);
      return true; // Filter
    }
  }

  // EMOJI CHECK (third priority)
  if (!prefs.notifyOnEmoji && isEmojiOnlyMessage(filterContext.messageText)) {
    logger.debug(`😀 Emoji-only message filtered for user ${userId}`);
    return true; // Filter
  }

  // MQTT CHECK (fourth priority)
  if (!prefs.notifyOnMqtt && filterContext.viaMqtt === true) {
    logger.debug(`📡 MQTT message filtered for user ${userId}`);
    return true; // Filter
  }

  // CHANNEL/DM CHECK (fifth priority)
  if (filterContext.isDirectMessage) {
    if (!prefs.enableDirectMessages) {
      logger.debug(`🔇 Direct messages disabled for user ${userId}`);
      return true; // Filter
    }
  } else {
    if (!prefs.enabledChannels.includes(filterContext.channelId)) {
      logger.debug(`🔇 Channel ${filterContext.channelId} disabled for user ${userId}`);
      return true; // Filter
    }
  }

  return false; // Don't filter (allow by default)
}

/**
 * Resolve the Apprise delivery target for a user in the TARGETED alert
 * pipeline (low-battery, inactive-node — the check service already knows
 * this specific user should be notified; this resolver only answers "what
 * URLs / prefix setting do we use").
 *
 * #4020: a user's `enableApprise`/`appriseUrls`/`prefixWithNodeName` can live
 * on a different (userId, sourceId) row than the one that triggered the
 * eligibility check (e.g. the flag was saved on the '' row, the URLs on a
 * per-source row). Visits rows in priority order — exact sourceId first,
 * then '' (default), then any remaining rows (already sourceId ASC) — and
 * returns the first row with both Apprise enabled and at least one URL.
 * Returns null when no row has a usable channel.
 *
 * This is deliberate and is NOT the per-source read that message and
 * new-node/traceroute/server-event notifications use. Low-battery and
 * inactive-node alerts are about a watch list of named nodes, which the user
 * edits from any source's tab and which can name nodes on other sources; the
 * alert must reach the user wherever they set up delivery. Only the answer to
 * "where do I send it" crosses rows here, never a filter decision.
 */
export async function resolveAppriseTargetAsync(
  userId: number,
  sourceId?: string
): Promise<{ urls: string[]; prefixWithNodeName: boolean } | null> {
  const rows = await databaseService.notifications.getUserPreferenceRows(userId);
  if (rows.length === 0) return null;

  const ordered = [...rows];
  if (sourceId) {
    const idx = ordered.findIndex((r) => r.sourceId === sourceId);
    if (idx > 0) {
      const [exact] = ordered.splice(idx, 1);
      ordered.unshift(exact);
    }
  }

  for (const row of ordered) {
    if (row.prefs.enableApprise && row.prefs.appriseUrls && row.prefs.appriseUrls.length > 0) {
      return { urls: row.prefs.appriseUrls, prefixWithNodeName: row.prefs.prefixWithNodeName };
    }
  }
  return null;
}

/**
 * Title and body of a message notification for ONE recipient (#5593).
 *
 * Call this only AFTER the filter decision for that recipient: it reads the
 * user's templates and nothing else, so it cannot change who is notified or
 * how many notifications go out.
 *
 * - `message` present: render the user's templates for this source (or the
 *   built-in default — anonymous subscribers always get the default). The
 *   source name is wherever the template puts it; no `[sourceName]` prefix is
 *   added, so the default shows it exactly once.
 *
 *   Templates come from the EXACT (userId, sourceId) row only: a template
 *   saved for source A never shapes a notification from source B.
 * - `message` absent (a caller that built its own strings): keep the legacy
 *   `[sourceName] title`, which is that caller's only mention of the source.
 *
 * The per-user `[localNodeName]` prefix is NOT applied here; delivery wrappers
 * add it to the rendered body afterwards, the same for a default and a custom
 * template.
 */
export async function renderMessagePayloadForUserAsync(
  userId: number | null | undefined,
  payload: { title: string; body: string; message?: MessageTemplateContext },
  sourceId: string,
  sourceName: string,
): Promise<{ title: string; body: string }> {
  if (!payload.message) {
    return { title: `[${sourceName}] ${payload.title}`, body: payload.body };
  }
  let prefs: NotificationPreferences | null = null;
  if (userId && sourceId) {
    try {
      prefs = await databaseService.notifications.getUserPreferences(userId, sourceId);
    } catch (error) {
      // A failed read must not cost the user the notification: use the default.
      logger.error(`Failed to load message templates for user ${userId} on source ${sourceId}:`, error);
    }
  }
  return renderMessageNotification(payload.message, {
    titleTemplate: prefs?.messageTitleTemplate,
    bodyTemplate: prefs?.messageBodyTemplate,
  });
}

/**
 * Apply node name prefix to a notification body if the user has it enabled
 * @param userId - The user ID to check preferences for
 * @param body - The original notification body
 * @param nodeName - The local node name to use as prefix
 * @returns The body with prefix if enabled, otherwise the original body
 */
export async function applyNodeNamePrefixAsync(
  userId: number | null | undefined,
  body: string,
  nodeName: string | null | undefined,
  sourceId?: string
): Promise<string> {
  // No prefix if no user ID or node name
  if (!userId || !nodeName) {
    return body;
  }

  // Check user preferences (per-source if provided)
  const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);
  if (!prefs || !prefs.prefixWithNodeName) {
    return body;
  }

  // Apply prefix
  return `[${nodeName}] ${body}`;
}
