import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

export interface NotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
}

export interface NotificationPreferences {
  enableWebPush: boolean;
  enableApprise: boolean;
  enabledChannels: number[];
  enableDirectMessages: boolean;
  notifyOnEmoji: boolean;
  notifyOnNewNode: boolean;
  notifyOnTraceroute: boolean;
  notifyOnInactiveNode: boolean;
  monitoredNodes: string[];
  whitelist: string[];
  blacklist: string[];
}

/**
 * Load notification preferences for a user from the database
 * Falls back to settings table for backward compatibility during migration
 */
export function getUserNotificationPreferences(userId: number): NotificationPreferences | null {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return null;
  }

  try {
    // Try to load from new table first
    const stmt = databaseService.db.prepare(`
      SELECT
        enable_web_push,
        enable_apprise,
        enabled_channels,
        enable_direct_messages,
        notify_on_emoji,
        notify_on_new_node,
        notify_on_traceroute,
        notify_on_inactive_node,
        monitored_nodes,
        whitelist,
        blacklist
      FROM user_notification_preferences
      WHERE user_id = ?
    `);

    const row = stmt.get(userId) as any;

    if (row) {
      // Parse JSON fields
      return {
        enableWebPush: Boolean(row.enable_web_push),
        enableApprise: Boolean(row.enable_apprise),
        enabledChannels: row.enabled_channels ? JSON.parse(row.enabled_channels) : [],
        enableDirectMessages: Boolean(row.enable_direct_messages),
        notifyOnEmoji: row.notify_on_emoji !== undefined ? Boolean(row.notify_on_emoji) : true,
        notifyOnNewNode: row.notify_on_new_node !== undefined ? Boolean(row.notify_on_new_node) : true,
        notifyOnTraceroute: row.notify_on_traceroute !== undefined ? Boolean(row.notify_on_traceroute) : true,
        notifyOnInactiveNode: row.notify_on_inactive_node !== undefined ? Boolean(row.notify_on_inactive_node) : false,
        monitoredNodes: row.monitored_nodes ? JSON.parse(row.monitored_nodes) : [],
        whitelist: row.whitelist ? JSON.parse(row.whitelist) : [],
        blacklist: row.blacklist ? JSON.parse(row.blacklist) : []
      };
    }

    // Fall back to old settings table for backward compatibility
    const prefsJson = databaseService.getSetting(`push_prefs_${userId}`);
    if (prefsJson) {
      const oldPrefs = JSON.parse(prefsJson);
      return {
        enableWebPush: true, // Old users had push enabled
        enableApprise: false, // New feature, default to disabled
        enabledChannels: oldPrefs.enabledChannels || [],
        enableDirectMessages: oldPrefs.enableDirectMessages !== undefined
          ? oldPrefs.enableDirectMessages
          : true,
        notifyOnEmoji: true, // Default to enabled for backward compatibility
        notifyOnNewNode: true, // Default to enabled for backward compatibility
        notifyOnTraceroute: true, // Default to enabled for backward compatibility
        notifyOnInactiveNode: false, // Default to disabled
        monitoredNodes: [], // Default to empty array
        whitelist: oldPrefs.whitelist || [],
        blacklist: oldPrefs.blacklist || []
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
 */
export function saveUserNotificationPreferences(
  userId: number,
  preferences: NotificationPreferences
): boolean {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return false;
  }

  try {
    const now = Date.now();
    const stmt = databaseService.db.prepare(`
      INSERT INTO user_notification_preferences (
        user_id, enable_web_push, enable_apprise,
        enabled_channels, enable_direct_messages, notify_on_emoji,
        notify_on_new_node, notify_on_traceroute,
        notify_on_inactive_node, monitored_nodes,
        whitelist, blacklist,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        enable_web_push = excluded.enable_web_push,
        enable_apprise = excluded.enable_apprise,
        enabled_channels = excluded.enabled_channels,
        enable_direct_messages = excluded.enable_direct_messages,
        notify_on_emoji = excluded.notify_on_emoji,
        notify_on_new_node = excluded.notify_on_new_node,
        notify_on_traceroute = excluded.notify_on_traceroute,
        notify_on_inactive_node = excluded.notify_on_inactive_node,
        monitored_nodes = excluded.monitored_nodes,
        whitelist = excluded.whitelist,
        blacklist = excluded.blacklist,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      userId,
      preferences.enableWebPush ? 1 : 0,
      preferences.enableApprise ? 1 : 0,
      JSON.stringify(preferences.enabledChannels),
      preferences.enableDirectMessages ? 1 : 0,
      preferences.notifyOnEmoji ? 1 : 0,
      preferences.notifyOnNewNode ? 1 : 0,
      preferences.notifyOnTraceroute ? 1 : 0,
      preferences.notifyOnInactiveNode ? 1 : 0,
      JSON.stringify(preferences.monitoredNodes),
      JSON.stringify(preferences.whitelist),
      JSON.stringify(preferences.blacklist),
      now,
      now
    );

    return true;
  } catch (error) {
    logger.error(`Failed to save preferences for user ${userId}:`, error);
    return false;
  }
}

/**
 * Get users who have a specific notification service enabled
 */
export function getUsersWithServiceEnabled(service: 'web_push' | 'apprise'): number[] {
  try {
    // Security: Use explicit column mapping to prevent SQL injection
    // Even though service is type-constrained, we explicitly validate and map columns
    const COLUMN_MAP: Record<'web_push' | 'apprise', string> = {
      'web_push': 'enable_web_push',
      'apprise': 'enable_apprise'
    };

    const column = COLUMN_MAP[service];
    if (!column) {
      throw new Error(`Invalid service type: ${service}`);
    }

    // Now safe to use column name in query since it's from a whitelist
    const stmt = databaseService.db.prepare(`
      SELECT user_id
      FROM user_notification_preferences
      WHERE ${column} = 1
    `);
    const rows = stmt.all() as any[];
    return rows.map(row => row.user_id);
  } catch (error) {
    logger.debug(`No user_notification_preferences table yet, returning empty array`);
    return [];
  }
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
 * Check if a notification should be filtered for a specific user
 *
 * Filtering logic (priority order):
 * 1. WHITELIST - If message contains whitelisted word, ALLOW (highest priority)
 * 2. BLACKLIST - If message contains blacklisted word, FILTER
 * 3. EMOJI - If notifyOnEmoji is disabled and message is emoji-only, FILTER
 * 4. CHANNEL/DM - If channel/DM is disabled, FILTER
 * 5. DEFAULT - ALLOW
 */
export function shouldFilterNotification(
  userId: number,
  filterContext: NotificationFilterContext
): boolean {
  // Validate userId
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.error(`❌ Invalid userId: ${userId}`);
    return false; // Allow on validation error (fail-open for UX)
  }

  // Load user preferences
  const prefs = getUserNotificationPreferences(userId);
  if (!prefs) {
    logger.debug(`No preferences for user ${userId}, allowing notification`);
    return false; // Allow if no preferences found
  }

  const messageTextLower = filterContext.messageText.toLowerCase();

  // WHITELIST (highest priority)
  for (const word of prefs.whitelist) {
    if (word && messageTextLower.includes(word.toLowerCase())) {
      logger.debug(`✅ Whitelist match for user ${userId}: "${word}"`);
      return false; // Don't filter
    }
  }

  // BLACKLIST (second priority)
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

  // CHANNEL/DM CHECK (fourth priority)
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
