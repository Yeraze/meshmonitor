/**
 * Traffic Management replay (#5670): the I/O around the pure simulator in
 * `src/utils/trafficManagementReplay.ts`.
 *
 * It reads ONE source's packet log and that source's channels and nodes, and
 * runs the simulator. It sends nothing to the node and writes nothing.
 */
import databaseService from '../../services/database.js';
import packetLogService from './packetLogService.js';
import type { MeshtasticManager } from '../meshtasticManager.js';
import type { NodeViewAccess } from '../utils/nodeEnhancer.js';
import { canSeePacketContent } from '../routes/packetPermissions.js';
import { getPskBase64ByteLength } from '../../utils/channelUrl.js';
import { PortNum } from '../constants/meshtastic.js';
import {
  isWellKnownChannel,
  simulateTrafficReplay,
  type ReplayChannel,
  type ReplayPacket,
  type TrafficReplayResponse,
  type ReplaySettings,
} from '../../utils/trafficManagementReplay.js';

/**
 * Most rows one replay reads. The log's own cap is a setting an admin can
 * raise; this bounds memory and CPU whatever it is set to. When the log holds
 * more, the replay uses the newest rows and says so (`truncated`).
 */
export const TRAFFIC_REPLAY_SCAN_CAP = 50_000;
/** Rows per query while paging back through the log. */
export const TRAFFIC_REPLAY_PAGE_SIZE = 5_000;

export interface PacketContentAccess {
  isAdmin: boolean;
  allowedChannels: Set<number>;
  canReadMessages: boolean;
}

export class TrafficReplayUnavailableError extends Error {
  constructor(public readonly code: 'TRAFFIC_MANAGEMENT_UNSUPPORTED' | 'TRAFFIC_MANAGEMENT_CONFIG_NOT_LOADED' | 'SOURCE_NOT_CONNECTED', message: string) {
    super(message);
  }
}

/** The integer coordinates of a logged POSITION row, when it carries both. */
function positionFromMetadata(metadata: string | null): ReplayPacket['position'] {
  if (!metadata) return null;
  try {
    const payload = (JSON.parse(metadata) as { decoded_payload?: Record<string, unknown> }).decoded_payload;
    if (!payload) return null;
    const lat = payload.latitudeI ?? payload.latitude_i;
    const lon = payload.longitudeI ?? payload.longitude_i;
    return typeof lat === 'number' && typeof lon === 'number' ? { latitudeI: lat, longitudeI: lon } : null;
  } catch {
    return null;
  }
}

/** What the node runs now, as it last reported it. */
export function currentSettingsOf(manager: MeshtasticManager): ReplaySettings {
  if (!manager.supportsTrafficManagement()) {
    throw new TrafficReplayUnavailableError(
      'TRAFFIC_MANAGEMENT_UNSUPPORTED',
      'Traffic Management needs Meshtastic firmware 2.8.0 or newer on this node.',
    );
  }
  const tm = manager.getCurrentConfig().moduleConfig?.trafficManagement as Partial<ReplaySettings> | undefined;
  if (!tm) {
    throw new TrafficReplayUnavailableError(
      'TRAFFIC_MANAGEMENT_CONFIG_NOT_LOADED',
      'The node has not reported its Traffic Management settings yet. Load the module config and try again.',
    );
  }
  return {
    positionMinIntervalSecs: Number(tm.positionMinIntervalSecs ?? 0),
    rateLimitWindowSecs: Number(tm.rateLimitWindowSecs ?? 0),
    rateLimitMaxPackets: Number(tm.rateLimitMaxPackets ?? 0),
  };
}

export async function runTrafficReplay(args: {
  sourceId: string;
  manager: MeshtasticManager;
  proposed: ReplaySettings;
  nodeAccess: NodeViewAccess;
  packetAccess: PacketContentAccess;
}): Promise<TrafficReplayResponse> {
  const { sourceId, manager, proposed, nodeAccess, packetAccess } = args;

  const localNodeNum = manager.getLocalNodeInfo()?.nodeNum;
  const status = await manager.getConnectionStatus();
  if (!status.connected || !localNodeNum) {
    throw new TrafficReplayUnavailableError(
      'SOURCE_NOT_CONNECTED',
      'This source has no connected node, so there are no current settings to compare against.',
    );
  }
  const current = currentSettingsOf(manager);
  const loggingEnabled = await packetLogService.isEnabled();

  const [channelRows, nodeRows] = await Promise.all([
    databaseService.channels.getAllChannels(sourceId),
    databaseService.nodes.getAllNodes(sourceId),
  ]);

  const usePreset = manager.getCurrentConfig().deviceConfig?.lora?.usePreset === true;
  const channels = new Map<number, ReplayChannel>();
  for (const row of channelRows) {
    channels.set(Number(row.id), {
      wellKnown: isWellKnownChannel({
        index: Number(row.id),
        name: row.name,
        pskByteLength: getPskBase64ByteLength(row.psk),
        usePreset,
      }),
      positionPrecision: Number(row.positionPrecision ?? 0),
    });
  }

  // A sender is named only when the caller could already see that node on this
  // source: it has a row here, and the caller may view the channel it was last
  // heard on (the same rule the node list uses). Anyone else folds into "other".
  const senderRoles = new Map<number, number>();
  const visibleNodes = new Map<number, { nodeId: string; shortName: string | null; longName: string | null }>();
  for (const node of nodeRows) {
    const nodeNum = Number(node.nodeNum);
    if (node.role !== null && node.role !== undefined) senderRoles.set(nodeNum, Number(node.role));
    if (nodeAccess.canViewNode(sourceId, node.channel)) {
      visibleNodes.set(nodeNum, { nodeId: node.nodeId, shortName: node.shortName, longName: node.longName });
    }
  }

  // Page back from the newest row; stop at the cap.
  const packets: ReplayPacket[] = [];
  let before: { timestamp: number; id: number } | undefined;
  let truncated = false;
  if (loggingEnabled) {
    for (;;) {
      const want = Math.min(TRAFFIC_REPLAY_PAGE_SIZE, TRAFFIC_REPLAY_SCAN_CAP - packets.length);
      if (want <= 0) {
        // One more row past the cap means older history was left unread.
        truncated = (await databaseService.packetLog.scanForTrafficReplay({ sourceId, limit: 1, before })).length > 0;
        break;
      }
      const page = await databaseService.packetLog.scanForTrafficReplay({ sourceId, limit: want, before });
      for (const row of page) {
        const serverDecrypted = row.decrypted_by === 'server';
        packets.push({
          timestampMs: row.timestamp,
          from: row.from_node,
          to: row.to_node,
          channel: row.channel,
          portnum: row.portnum,
          decodedByNode: !row.encrypted && !serverDecrypted,
          serverDecrypted,
          isTx: row.direction === 'tx',
          // Only POSITION rows carry metadata out of the scan.
          position: row.portnum === PortNum.POSITION_APP ? positionFromMetadata(row.position_metadata) : null,
          senderHidden: !visibleNodes.has(row.from_node),
          portHidden: !canSeePacketContent(
            { encrypted: row.encrypted, channel: row.channel, portnum: row.portnum, to_node: row.to_node },
            packetAccess.allowedChannels,
            packetAccess.isAdmin,
            packetAccess.canReadMessages,
          ),
        });
      }
      if (page.length < want) break;
      const last = page[page.length - 1];
      before = { timestamp: last.timestamp, id: last.id };
    }
    packets.reverse(); // oldest first for the replay
  }

  const result = simulateTrafficReplay({
    loggingEnabled,
    packets,
    truncated,
    scanCap: TRAFFIC_REPLAY_SCAN_CAP,
    current,
    proposed,
    localNodeNum,
    channels,
    senderRoles,
  });

  const senders: TrafficReplayResponse['senders'] = {};
  for (const outcome of [result.positionDedup, result.rateLimit]) {
    if (outcome.status !== 'estimate') continue;
    for (const row of outcome.bySender) {
      const node = row.key === null ? undefined : visibleNodes.get(row.key);
      if (row.key !== null && node) senders[String(row.key)] = node;
    }
  }

  return { ...result, sourceId, senders };
}
