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
  viaMqtt?: boolean | null;
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
 * Human-readable service label from a Source.type, for notification titles
 * (#4845). Lets a mobile notification say "New Meshtastic Message" vs
 * "New MeshCore Message" at a glance across a multi-source install.
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

    // Determine notification title and body (#4845):
    //   Title: "New {Service} Message" / "New {Service} Direct Message"
    //   Body:  line 1 "{Channel} • {Source}" (DM: just "{Source}")
    //          line 2 "{Sender}: {text}"
    const truncatedText = messageText.length > 100 ? messageText.substring(0, 97) + '...' : messageText;
    const title = isDirectMessage
      ? `New ${serviceLabel} Direct Message`
      : `New ${serviceLabel} Message`;
    const locationLine = isDirectMessage
      ? sourceName
      : `${await resolveChannelName(message.channel, sourceId)} • ${sourceName}`;
    const body = `${locationLine}\n${senderName}: ${truncatedText}`;

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

    // Send notifications (Web Push + Apprise) with filtering to all subscribed users
    const result = await notificationService.broadcast({
      title,
      body,
      data: navigationData,
      sourceId,
      sourceName,
    }, {
      messageText,
      channelId: message.channel,
      isDirectMessage,
      viaMqtt: message.viaMqtt === true,
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
