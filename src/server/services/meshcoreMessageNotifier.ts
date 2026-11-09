/**
 * MeshCore new-message notifications (P11 #6253, S3 + S5).
 *
 * Adapter over the shared `dispatchMessageNotification`: it only resolves what
 * is MeshCore-specific (identity is a public key, channels are `channel-N`
 * keys, rooms have no Meshtastic equivalent) and hands the rest to the shared
 * pipeline, which applies every per-user rule (channel enable and mute, DM
 * toggle, keywords, emoji, templates, cross-source dedup, key access).
 *
 * Venues:
 * - channel: `isDirectMessage` false, no mute key;
 * - DM: `isDirectMessage` true, mute key = the sender's full key;
 * - room post: follows the DM toggle and `mutedDMs`, mute key = the room key,
 *   rendered as a channel-style "{Room} · {Source}".
 *
 * Mesh impact: sends nothing over the air and arms no timer.
 */
import { isReactionText } from '../../utils/meshcoreReactions.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { dispatchMessageNotification } from './messagePushNotifier.js';
import { meshcoreMentionNotificationService } from './meshcoreMentionNotificationService.js';
import { meshcoreNotificationKey } from './meshcoreNotificationKey.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import { isOwnMeshCoreName, isOwnPublicKey } from '../utils/ownNodes.js';
import { meshcoreChannelIndexOf } from '../utils/meshcoreMessageMerge.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

export type MeshCoreNotifyOutcome =
  | 'sent'
  | 'skipped:filtered'
  | 'skipped:self'
  | 'skipped:empty';

const FULL_KEY = /^[0-9a-f]{64}$/i;

interface ContactLookup {
  ownKey: string | null;
  resolve(key: string): { publicKey: string; name: string | null } | null;
}

function lookupFor(sourceId: string): ContactLookup {
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (!manager || !isMeshCoreManager(manager)) return { ownKey: null, resolve: () => null };
  return {
    ownKey: manager.getLocalNode()?.publicKey?.toLowerCase() ?? null,
    resolve: (key) => {
      const c = manager.getContact(key) ?? manager.resolveContactByPrefix(key);
      return c ? { publicKey: c.publicKey, name: c.advName || c.name || null } : null;
    },
  };
}

/** Send the notification for one received MeshCore message. Never throws. */
export async function sendMeshCoreMessageNotification(
  msg: MeshCoreMessage,
  sourceId: string,
): Promise<MeshCoreNotifyOutcome> {
  if (msg.filtered) return 'skipped:filtered';

  const isRoom = msg.messageType === 'room_post';
  const channelIdx = isRoom ? null : meshcoreChannelIndexOf(msg);
  const isChannel = channelIdx !== null;

  const contacts = lookupFor(sourceId);
  const fromRaw = (msg.fromPublicKey ?? '').toLowerCase();
  const senderName = (msg.fromName ?? '').trim();
  if (
    msg.selfOrigin === true ||
    fromRaw === 'local' ||
    (contacts.ownKey && fromRaw === contacts.ownKey) ||
    (fromRaw && isOwnPublicKey(fromRaw)) ||
    // A channel echo of our own post carries no key, only our name.
    (isChannel && senderName && isOwnMeshCoreName(senderName))
  ) {
    return 'skipped:self';
  }

  const isTapback = !!msg.reactionEmoji || isReactionText(msg.text);
  let text = (msg.text ?? '').trim();
  if (!text && msg.reactionEmoji) text = msg.reactionEmoji;
  if (!text) return 'skipped:empty';

  const source = await databaseService.sources.getSource(sourceId).catch(() => null);
  const viaMqtt = source?.type === 'meshcore_mqtt';

  try {
    if (isChannel) {
      await dispatchMessageNotification({
        sourceId,
        messageId: msg.id,
        isDirectMessage: false,
        channelId: channelIdx,
        senderName: senderName || 'Unknown',
        senderShortName: senderName || 'Unknown',
        text,
        isTapback,
        viaMqtt,
        dedupKey: meshcoreNotificationKey(msg),
        keyFingerprint: msg.keyFingerprint ?? null,
      });
      return 'sent';
    }

    // DM senders may arrive as a short prefix; mutes are keyed by the full key.
    const resolved = fromRaw && !FULL_KEY.test(fromRaw) ? contacts.resolve(fromRaw) : null;
    const fromKey = (resolved?.publicKey ?? fromRaw).toLowerCase();
    const displayName = senderName || resolved?.name || fromKey.slice(0, 8) || 'Unknown';

    if (isRoom) {
      const roomRaw = (msg.toPublicKey ?? '').toLowerCase();
      const room = roomRaw ? contacts.resolve(roomRaw) : null;
      const roomKey = (room?.publicKey ?? roomRaw).toLowerCase();
      const roomName = room?.name || 'Room';
      await dispatchMessageNotification({
        sourceId,
        messageId: msg.id,
        isDirectMessage: true,
        channelId: -1,
        senderName: displayName,
        senderShortName: displayName,
        senderNavId: roomKey || undefined,
        text,
        isTapback,
        viaMqtt,
        dedupKey: meshcoreNotificationKey(msg, { fromKey, roomKey }),
        muteKey: roomKey || undefined,
        keyFingerprint: msg.keyFingerprint ?? null,
        template: { isDM: false, channelName: roomName },
      });
      return 'sent';
    }

    await dispatchMessageNotification({
      sourceId,
      messageId: msg.id,
      isDirectMessage: true,
      channelId: -1,
      senderName: displayName,
      senderShortName: displayName,
      senderNavId: fromKey || undefined,
      text,
      isTapback,
      viaMqtt,
      dedupKey: meshcoreNotificationKey(msg, { fromKey }),
      muteKey: fromKey || undefined,
      keyFingerprint: msg.keyFingerprint ?? null,
    });
    return 'sent';
  } catch (e) {
    logger.error(`[MeshCoreNotify] dispatch error: ${(e as Error)?.message}`);
    return 'sent';
  }
}

let subscribed = false;
/** One chain per source: events of a source run in order, sources run in parallel. */
const chains = new Map<string, Promise<unknown>>();

async function handle(msg: MeshCoreMessage, sourceId: string): Promise<void> {
  // Mention first, so its alert claims the dedup key and the message copy for
  // the same recipient is dropped as a duplicate.
  try {
    await meshcoreMentionNotificationService.handleMessage(msg, sourceId);
  } catch (e) {
    logger.error(`[MeshCoreMention] handler error: ${(e as Error)?.message}`);
  }
  try {
    await sendMeshCoreMessageNotification(msg, sourceId);
  } catch (e) {
    logger.error(`[MeshCoreNotify] handler error: ${(e as Error)?.message}`);
  }
}

/** Subscribe to received MeshCore messages: mention alert, then message alert. */
export function startMeshCoreMessageNotifications(): void {
  if (subscribed) return;
  subscribed = true;
  dataEventEmitter.on('data', (event: DataEvent) => {
    if (event.type !== 'meshcore:message' || !event.sourceId) return;
    const sourceId = event.sourceId;
    const msg = event.data as MeshCoreMessage;
    const prev = chains.get(sourceId) ?? Promise.resolve();
    const next = prev.then(() => handle(msg, sourceId));
    chains.set(sourceId, next.catch(() => undefined));
  });
}
