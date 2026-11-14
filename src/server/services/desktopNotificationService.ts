/**
 * Desktop Notification Service
 *
 * Sends native OS notifications via node-notifier when running in the
 * Tauri desktop app (IS_DESKTOP=true). Integrates with the unified
 * notification pipeline alongside web push and Apprise.
 *
 * Uses the same user preference filtering as web push — the enableWebPush
 * preference controls desktop notifications in desktop mode.
 */

import notifier from 'node-notifier';
import path from 'path';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { shouldFilterNotificationAsync, getUserNotificationPreferencesAsync, renderMessagePayloadForUserAsync, messageReadableByUserAsync, payloadBlockedForUserAsync, userReadsAnySourceAsync, type NotificationMuteVenue } from '../utils/notificationFiltering.js';
import type { MessageTemplateContext } from '../../utils/notificationTemplate.js';
import { notificationDedup, notificationHold, joinSourceNames, type DedupSource, type NotificationDedupSpec } from './notificationDedup.js';

/**
 * Dedup recipient for the desktop app (#5729): the one machine. A desktop
 * notification is shown once, for the first user who passes, so the machine
 * is the unit, not the user. The first copy starts a 5 s hold owned by that
 * user; a later copy joins it only when the SAME user passes on the later
 * source, so the list never shows a source that user cannot read.
 */
const DESKTOP_DEDUP_RECIPIENT = 'desktop';

/** What a desktop hold remembers about its first copy. */
interface DesktopHoldMeta {
  ownerUserId: number;
}

export interface DesktopNotificationPayload {
  title: string;
  body: string;
  type?: 'info' | 'success' | 'warning' | 'failure' | 'error';
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name used to prefix title/body. */
  sourceName: string;
  /**
   * Message notifications only (#5593): the values `broadcastWithFiltering`
   * renders the recipient's title/body template from.
   */
  message?: MessageTemplateContext;
  /** Cross-source dedup (#5729); see `notificationDedup.ts`. */
  dedup?: NotificationDedupSpec;
  /**
   * MeshCore keyed channel message (#5551): only recipients with access to this
   * channel key get the event. Server-side input; never shown.
   */
  keyFingerprint?: string | null;
  /**
   * Venue of an event that follows a mute (a mention): a recipient who muted
   * it is skipped. Server-side input; never shown.
   */
  muteVenue?: NotificationMuteVenue;
  /**
   * New-node alert (#5729, decision 5): sources where this node was already
   * known before this source announced it. A recipient who can read any of
   * them heard of the node from there first and is skipped. Server-side
   * input; never sent on the wire.
   */
  knownOnSourceIds?: string[];
}

export interface DesktopNotificationFilterContext {
  messageText: string;
  channelId: number;
  isDirectMessage: boolean;
  viaMqtt?: boolean;
  /** #5720: the packet is a protocol tapback (Meshtastic `emoji === 1`). */
  isTapback?: boolean;
  /** MeshCore keyed channel message (#5551): recipient needs access to this key. */
  keyFingerprint?: string | null;
  /** DM / room mute key (`mutedDMs.nodeUuid`), so a per-DM mute applies. */
  nodeUuid?: string;
  /** Phase B: source this notification originated from (required). */
  sourceId: string;
  /** Phase B: human-readable source name. */
  sourceName: string;
}

class DesktopNotificationService {
  private enabled = false;

  constructor() {
    // Enable if running in desktop/Tauri mode (IS_DESKTOP is set by lib.rs)
    this.enabled = process.env.IS_DESKTOP === 'true' ||
                   process.env.ENABLE_DESKTOP_NOTIFICATIONS === 'true';

    if (this.enabled) {
      logger.info('🖥️ Desktop notification service enabled');
    }
  }

  isAvailable(): boolean {
    return this.enabled;
  }

  /**
   * Cross-source dedup (#5729). node-notifier cannot replace a notification
   * it has already shown, so the first copy starts a 5 s hold, later copies
   * inside it add their source, then ONE notification lists them all.
   *
   * `render` builds the notification for the collected sources. Returns
   * 'send' when there is no dedup key (send now), 'held' when the copy was
   * taken by a hold, 'drop' otherwise.
   */
  private claimDesktop(
    payload: DesktopNotificationPayload,
    sourceId: string,
    userId: number,
    render: (sources: DedupSource[]) => Promise<DesktopNotificationPayload>,
  ): 'send' | 'held' | 'drop' {
    if (!payload.dedup) return 'send';
    const key = payload.dedup.key;
    const source: DedupSource = { sourceId, sourceName: payload.sourceName };
    const claim = notificationDedup.claim(DESKTOP_DEDUP_RECIPIENT, key, source);
    if (claim.outcome === 'first') {
      const meta: DesktopHoldMeta = { ownerUserId: userId };
      notificationHold.start(DESKTOP_DEDUP_RECIPIENT, key, source, async (sources) => {
        const shown = await render(sources);
        return this.send(shown);
      }, meta);
      return 'held';
    }
    if (claim.outcome === 'additional') notificationHold.join(DESKTOP_DEDUP_RECIPIENT, key, source);
    return 'drop';
  }

  /**
   * The user who owns the live desktop hold for this event, if any. A later
   * copy may join only when THIS user passes on the later source.
   */
  private holdOwner(payload: DesktopNotificationPayload): number | undefined {
    if (!payload.dedup) return undefined;
    const meta = notificationHold.getMeta(DESKTOP_DEDUP_RECIPIENT, payload.dedup.key) as DesktopHoldMeta | undefined;
    return meta?.ownerUserId;
  }

  /**
   * Send a native OS notification
   */
  private send(payload: DesktopNotificationPayload): boolean {
    try {
      notifier.notify({
        title: payload.title,
        message: payload.body,
        icon: path.join(process.cwd(), 'public', 'logo.png'),
        sound: true,
        wait: false,
      });
      logger.debug(`🖥️ Desktop notification sent: ${payload.title}`);
      return true;
    } catch (error) {
      // A held copy that fails is released by the hold store, so another
      // source's copy can still be shown (#5729).
      logger.error('❌ Failed to send desktop notification:', error);
      return false;
    }
  }

  /**
   * Broadcast notification with user preference filtering.
   * Iterates over all users, applies filtering, sends once (single desktop machine).
   */
  async broadcastWithFiltering(
    payload: DesktopNotificationPayload,
    filterContext: DesktopNotificationFilterContext
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.enabled) return { sent: 0, failed: 0, filtered: 0 };

    let filtered = 0;

    try {
      const allUsers = await databaseService.auth.getAllUsers();
      // A live hold for this event: only its owner may add this source.
      const owner = this.holdOwner(payload);
      const users = owner === undefined ? allUsers : allUsers.filter(u => u.id === owner);

      for (const user of users) {
        if (!user.isActive) continue;

        // Phase B: permission check — user must have messages:read on this
        // source and, for a keyed MeshCore message, access to its channel key.
        if (!(await messageReadableByUserAsync(user.id, filterContext.sourceId, filterContext.keyFingerprint))) {
          filtered++;
          continue;
        }

        // Check if user has web push enabled (controls desktop notifications too) — per-source
        const prefs = await getUserNotificationPreferencesAsync(user.id, filterContext.sourceId);
        if (!prefs || !prefs.enableWebPush) continue;

        // Apply same filtering as web push
        if (await shouldFilterNotificationAsync(user.id, filterContext)) {
          filtered++;
          continue;
        }

        // Render AFTER the filter decision (#5593), with the templates of the
        // user this single desktop notification is sent for.
        const render = async (sources: DedupSource[]): Promise<DesktopNotificationPayload> => {
          const shownName = joinSourceNames(sources);
          const renderInput = payload.message
            ? { ...payload, message: { ...payload.message, sourceName: shownName } }
            : payload;
          const rendered = await renderMessagePayloadForUserAsync(user.id, renderInput, sources[0].sourceId, shownName, 'desktop');
          return { ...payload, title: rendered.title, body: rendered.body };
        };

        // Dedup AFTER the filter decision (#5729): a copy no user would have
        // been shown must not use up the event.
        const outcome = this.claimDesktop(payload, filterContext.sourceId, user.id, render);
        if (outcome === 'drop') return { sent: 0, failed: 0, filtered: filtered + 1 };
        if (outcome === 'held') return { sent: 1, failed: 0, filtered };

        const ok = this.send(await render([{ sourceId: filterContext.sourceId, sourceName: filterContext.sourceName }]));
        // Only send once — single desktop machine
        return ok ? { sent: 1, failed: 0, filtered } : { sent: 0, failed: 1, filtered };
      }

      return { sent: 0, failed: 0, filtered };
    } catch (error) {
      logger.error('❌ Desktop notification broadcast error:', error);
      return { sent: 0, failed: 1, filtered };
    }
  }

  /**
   * Broadcast to users with a specific preference enabled (e.g., notifyOnNewNode).
   */
  async broadcastToPreferenceUsers(
    preferenceName: string,
    payload: DesktopNotificationPayload,
    sourceId?: string
  ): Promise<{ sent: number; failed: number; filtered: number }> {
    if (!this.enabled) return { sent: 0, failed: 0, filtered: 0 };

    // Phase C: scope preference broadcasts by sourceId
    const effectiveSourceId = sourceId ?? payload.sourceId;
    try {
      const allUsers = await databaseService.auth.getAllUsers();
      // A live hold for this event: only its owner may add this source.
      const owner = this.holdOwner(payload);
      const users = owner === undefined ? allUsers : allUsers.filter(u => u.id === owner);

      for (const user of users) {
        if (!user.isActive) continue;

        // Phase C: per-source permission check
        if (effectiveSourceId) {
          try {
            const allowed = await databaseService.checkPermissionAsync(user.id, 'messages', 'read', effectiveSourceId);
            if (!allowed) continue;
          } catch (err) {
            logger.error(`Permission check failed for user ${user.id}:`, err);
            continue;
          }
        }

        const prefs = await getUserNotificationPreferencesAsync(user.id, effectiveSourceId);
        if (!prefs || !prefs.enableWebPush) continue;
        if (!(prefs as any)[preferenceName]) continue;

        // Keyed MeshCore message / muted venue (mentions): a gate on the payload.
        if ((payload.keyFingerprint || payload.muteVenue) && await payloadBlockedForUserAsync(user.id, effectiveSourceId, payload)) continue;

        // New node already known on a source this user reads (#5729).
        if (await userReadsAnySourceAsync(user.id, payload.knownOnSourceIds)) continue;

        const dedup = payload.dedup;
        const render = async (sources: DedupSource[]): Promise<DesktopNotificationPayload> =>
          dedup?.merged && sources.length > 1
            ? { ...payload, ...dedup.merged(sources.map(s => s.sourceName)) }
            : payload;
        const outcome = this.claimDesktop(payload, effectiveSourceId ?? payload.sourceId, user.id, render);
        if (outcome === 'drop') return { sent: 0, failed: 0, filtered: 1 };
        if (outcome === 'held') return { sent: 1, failed: 0, filtered: 0 };

        const ok = this.send(payload);
        // Only send once — single desktop machine
        return ok ? { sent: 1, failed: 0, filtered: 0 } : { sent: 0, failed: 1, filtered: 0 };
      }

      return { sent: 0, failed: 0, filtered: 0 };
    } catch (error) {
      logger.error('❌ Desktop notification preference broadcast error:', error);
      return { sent: 0, failed: 1, filtered: 0 };
    }
  }
}

export const desktopNotificationService = new DesktopNotificationService();
