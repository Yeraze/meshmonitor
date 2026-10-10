/**
 * New-message push/Apprise notification (shared across ingestion paths).
 *
 * Extracted from `MeshtasticManager.sendMessagePushNotification` (#4593) so
 * MQTT-sourced messages get the same alerts. Before the extraction this logic
 * lived inline in meshtasticManager and was called from three TCP-only sites,
 * so a message ingested by `mqttIngestion.ts` (an `mqtt_bridge` or
 * `mqtt_broker` source) never produced a notification — new-NODE alerts worked
 * because those fire one layer down, in `databaseService.upsertNodeAsync`.
 *
 * Behaviour is unchanged for the Meshtastic path; the only additions are the
 * cross-source self-check (see `isOwnNodeNum`) and a channel-name fallback for
 * the `CHANNEL_DB_OFFSET`-encoded virtual channels MQTT messages carry.
 */

import { notificationService } from './notificationService.js';
import databaseService from '../../services/database.js';
import { PortNum, CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { isOwnNodeNum } from '../utils/ownNodes.js';
import { logger } from '../../utils/logger.js';
import { renderMessageNotification, type MessageTemplateContext } from '../../utils/notificationTemplate.js';
import { packetDedupKey } from './notificationDedup.js';
import { extractPacketIdFromRowId } from '../utils/messageRowId.js';

/**
 * The subset of a message row this notifier reads. Structurally satisfied by
 * both `DbMessage` (MQTT ingestion) and `TextMessage` (meshtasticManager).
 */
export interface NotifiableMessage {
  id: string;
  fromNodeNum: number;
  fromNodeId?: string | null;
  channel: number;
  portnum?: number | null;
  /**
   * The mesh packet id, when the caller has it. Otherwise it is read from the
   * row id (`${sourceId}_${fromNum}_${packetId}`), the same way the unified
   * message view does. Used only for cross-source dedup (#5729).
   */
  packetId?: number | null;
  viaMqtt?: boolean | null;
  /** Meshtastic tapback flag: 1 marks a reaction (#5720). */
  emoji?: number | null;
}

export interface MessagePushInput {
  /** The inserted message row. */
  message: NotifiableMessage;
  /** Plain text body used for the notification and for keyword filters. */
  messageText: string;
  isDirectMessage: boolean;
  sourceId: string;
  /**
   * The source's own local node number, when it has one. Messages from it are
   * skipped (we don't notify a user about their own outgoing message). MQTT
   * bridges have no local node — pass null and rely on the cross-source
   * `isOwnNodeNum` check below.
   */
  localNodeNum?: number | null;
}

/** Resolve a display name for the message's channel, including virtual (channel_database) ids. */
/**
 * Human-readable service label from a Source.type (#4845). Since #5593 it is
 * the `{{ serviceLabel }}` template token rather than part of a fixed title.
 */
function serviceLabelFromSourceType(type: string | undefined): string {
  switch (type) {
    case 'meshcore': return 'MeshCore';
    case 'meshtastic_tcp': return 'Meshtastic';
    case 'mqtt_bridge':
    case 'mqtt_broker': return 'MQTT';
    case 'reticulum': return 'Reticulum';
    default: return 'Mesh';
  }
}

async function resolveChannelName(channelId: number, sourceId: string): Promise<string> {
  try {
    const channel = await databaseService.channels.getChannelById(channelId, sourceId);
    if (channel?.name) return channel.name;
  } catch {
    // fall through to the channel_database lookup / numeric label
  }
  if (channelId >= CHANNEL_DB_OFFSET) {
    try {
      const row = await databaseService.channelDatabase.getByIdAsync(channelId - CHANNEL_DB_OFFSET);
      if (row?.name) return row.name;
    } catch {
      // fall through
    }
  }
  return `Channel ${channelId}`;
}

/**
 * Send notifications (Web Push + Apprise) for a newly ingested message.
 * Never throws — notification failures must not break message processing.
 */
export async function sendMessagePushNotification(input: MessagePushInput): Promise<void> {
  const { message, messageText, isDirectMessage, sourceId, localNodeNum } = input;
  try {
    // Skip if no notification services are available
    const serviceStatus = notificationService.getServiceStatus();
    if (!serviceStatus.anyAvailable) {
      return;
    }

    // Skip non-chat messages (telemetry, traceroutes, etc.). ATAK GeoChat
    // (PortNum.ATAK_PLUGIN, and its V2 form on PortNum.ATAK_PLUGIN_V2) is a
    // real chat message too — see processTakPacket / processTakV2Packet —
    // and gets a push notification the same as a text message (spec §7.3).
    if (message.portnum !== PortNum.TEXT_MESSAGE_APP && message.portnum !== PortNum.ATAK_PLUGIN && message.portnum !== PortNum.ATAK_PLUGIN_V2) {
      return;
    }

    // Skip messages from our own node. `localNodeNum` covers the source that
    // owns the node; `isOwnNodeNum` additionally covers our own traffic seen
    // through a source with no local identity — an MQTT bridge re-delivering
    // a message we sent on a different source (#4593).
    if (localNodeNum != null && Number(localNodeNum) === Number(message.fromNodeNum)) {
      logger.debug('⏭️  Skipping push notification for message from local node');
      return;
    }
    if (isOwnNodeNum(message.fromNodeNum)) {
      logger.debug('⏭️  Skipping push notification for message from one of our own nodes');
      return;
    }

    // Get sender info
    const fromNode = await databaseService.nodes.getNode(message.fromNodeNum);
    const senderName = fromNode?.longName || fromNode?.shortName || `Node ${message.fromNodeNum}`;

    // Resolve the source (name + service type) so the notification can say
    // which service, channel, and instance the message came from (#4845).
    const source = await databaseService.sources.getSource(sourceId);
    const sourceName = source?.name || sourceId;
    const serviceLabel = serviceLabelFromSourceType(source?.type);

    // The values a notification can show (#5593). Each delivery wrapper
    // renders the recipient's own title/body template from these, AFTER its
    // filter decision. With no saved template the built-in default applies:
    //   channel  title "{Channel} · {Source}"  body "{Sender}: {text}"
    //   DM       title "{Sender} · {Source}"   body "{text}"
    // so the source name appears exactly once (it used to appear in the title
    // prefix and again in the body).
    const templateContext: MessageTemplateContext = {
      sourceName,
      channelName: isDirectMessage ? '' : await resolveChannelName(message.channel, sourceId),
      senderName,
      senderShortName: fromNode?.shortName || senderName,
      text: messageText,
      serviceLabel,
      isDM: isDirectMessage,
    };
    // Default rendering: the fallback for a delivery path that does not render
    // per recipient, and what the debug log shows.
    const { title, body } = renderMessageNotification(templateContext);

    // Build navigation data for push notification click handling.
    // `sourceId` is required for the cold-launch deep link: the service
    // worker builds a `/source/<sourceId>/<tab>` route from it, because the
    // app root renders DashboardPage and never reads navigation data (#4463).
    const navigationData = isDirectMessage
      ? {
          type: 'dm' as const,
          sourceId,
          messageId: message.id,
          senderNodeId: fromNode?.nodeId || message.fromNodeId || undefined,
        }
      : {
          type: 'channel' as const,
          sourceId,
          channelId: message.channel,
          messageId: message.id,
        };

    // Cross-source dedup (#5729): every source that hears this packet builds
    // the same key, so the dispatcher sends one notification per recipient.
    // A row with no real packet id (the `Date.now()` fallback) yields null and
    // is never deduped.
    const dedupKey = packetDedupKey(
      message.fromNodeNum,
      message.packetId ?? extractPacketIdFromRowId(message.id),
      message.portnum,
    );

    // Send notifications (Web Push + Apprise) with filtering to all subscribed users
    const result = await notificationService.broadcast({
      title,
      body,
      data: navigationData,
      sourceId,
      sourceName,
      message: templateContext,
      ...(dedupKey ? { dedup: { key: dedupKey } } : {}),
    }, {
      messageText,
      channelId: message.channel,
      isDirectMessage,
      viaMqtt: message.viaMqtt === true,
      // #5720: the protocol flag is authoritative; the text check in the
      // filter is only the fallback for paths that lose it.
      isTapback: Number(message.emoji) === 1,
      sourceId,
      sourceName,
    });

    logger.debug(
      `📤 Sent notifications: ${result.total.sent} delivered, ${result.total.failed} failed, ${result.total.filtered} filtered ` +
      `(Push: ${result.webPush.sent}/${result.webPush.failed}/${result.webPush.filtered}, ` +
      `Apprise: ${result.apprise.sent}/${result.apprise.failed}/${result.apprise.filtered})`
    );
  } catch (error) {
    logger.error('❌ Error sending message push notification:', error);
    // Don't throw - push notification failures shouldn't break message processing
  }
}
