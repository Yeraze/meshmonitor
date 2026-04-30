import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

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
  notifyOnServerEvents: boolean;
  prefixWithNodeName: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
  appriseUrls: string[];
  mutedChannels: MutedChannel[];
  mutedDMs: MutedDM[];
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
 * Load notification preferences for a user from the database
 * Uses the notifications repository for database-agnostic queries
 */
export async function getUserNotificationPreferencesAsync(userId: number, sourceId?: string): Promise<NotificationPreferences | null> {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return null;
  }

  try {
    const prefs = await databaseService.notifications.getUserPreferences(userId, sourceId);
    if (prefs) {
      return prefs;
    }

    // Fall back to old settings table for backward compatibility.
    // Migration 028 deletes per-source rows that predate the per-source schema,
    // so any user who hasn't re-saved preferences in 4.0+ relies entirely on
    // this path. Hardcoding the notify* toggles to `true` here silently
    // re-enabled push categories that the user had explicitly turned off in
    // the legacy blob (issue #2867 — traceroute audio firing despite the
    // toggle being off). Respect every saved value; only fall back to defaults
    // when a field isn't present at all.
    const prefsJson = await databaseService.getSettingAsync(`push_prefs_${userId}`);
    if (prefsJson) {
      const oldPrefs = JSON.parse(prefsJson);
      const boolOr = (value: unknown, fallback: boolean): boolean =>
        typeof value === 'boolean' ? value : fallback;
      return {
        enableWebPush: boolOr(oldPrefs.enableWebPush, true),
        enableApprise: boolOr(oldPrefs.enableApprise, false),
        enabledChannels: oldPrefs.enabledChannels || [],
        enableDirectMessages: boolOr(oldPrefs.enableDirectMessages, true),
        notifyOnEmoji: boolOr(oldPrefs.notifyOnEmoji, true),
        notifyOnMqtt: boolOr(oldPrefs.notifyOnMqtt, true),
        notifyOnNewNode: boolOr(oldPrefs.notifyOnNewNode, true),
        notifyOnTraceroute: boolOr(oldPrefs.notifyOnTraceroute, true),
        notifyOnInactiveNode: boolOr(oldPrefs.notifyOnInactiveNode, false),
        notifyOnServerEvents: boolOr(oldPrefs.notifyOnServerEvents, false),
        prefixWithNodeName: boolOr(oldPrefs.prefixWithNodeName, false),
        monitoredNodes: oldPrefs.monitoredNodes || [],
        whitelist: oldPrefs.whitelist || [],
        blacklist: oldPrefs.blacklist || [],
        appriseUrls: oldPrefs.appriseUrls || [],
        mutedChannels: oldPrefs.mutedChannels || [],
        mutedDMs: oldPrefs.mutedDMs || [],
      };
    }

    logger.debug(`No preferences found for user ${userId}`);
    return null;
  } catch (error) {
    logger.error(`Failed to load preferences for user ${userId}:`, error);
    return null;
  }
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

  // Load user preferences (per-source)
  const prefs = await getUserNotificationPreferencesAsync(userId, filterContext.sourceId);
  if (!prefs) {
    logger.debug(`No preferences for user ${userId} on source ${filterContext.sourceId}, allowing notification`);
    return false; // Allow if no preferences found
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
