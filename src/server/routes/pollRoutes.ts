/**
 * Poll Routes
 *
 * GET /poll — consolidated polling endpoint, reduces multiple API calls to one.
 *
 * Extracted verbatim from server.ts (was `apiRouter.get('/poll', ...)`, L2819)
 * as part of #3502. Mounted at '/' in server.ts (matches the existing
 * '/'-mounted deviceRoutes/systemRoutes/scriptRoutes convention).
 */
import express from 'express';
import databaseService, { DbMessage } from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { MeshMessage } from '../../types/message.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, hasPermission } from '../auth/authMiddleware.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  hasAnyReadableVirtualChannel,
} from '../utils/virtualChannelPermissions.js';
import { transformChannel } from '../utils/channelView.js';
import { enhanceNodeForClient, filterNodesByChannelPermission, getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { PortNum } from '../constants/meshtastic.js';
import { transformDbMessageToMeshMessage } from '../utils/transformDbMessage.js';
import { resolveSourceConnectionConfig } from '../utils/resolveSourceConnectionConfig.js';
import { getEnvironmentConfig } from '../config/environment.js';

const env = getEnvironmentConfig();
const BASE_URL = env.baseUrl;

const router = express.Router();

// Consolidated polling endpoint - reduces multiple API calls to one
router.get('/poll', optionalAuth(), async (req, res) => {
  logger.debug('🔔 [POLL] Endpoint called');
  try {
    const result: {
      connection?: any;
      nodes?: any[];
      messages?: any[];
      unreadCounts?: any;
      channels?: any[];
      telemetryNodes?: any;
      config?: any;
      deviceConfig?: any;
      traceroutes?: any[];
      deviceNodeNums?: number[];
    } = {};

    // Optional sourceId scoping — when provided, use the matching manager and filter DB queries
    const pollSourceId = (req.query.sourceId as string | undefined) || undefined;
    const activeManager = resolveSourceManager(pollSourceId);

    // Pre-compute shared values used across multiple sections
    const user = (req as any).user;
    const userId = req.user?.id ?? null;
    const localNodeInfo = activeManager.getLocalNodeInfo();
    // Nodes are stored per-source (composite PK (nodeNum, sourceId) since migration
    // 029). Scope strictly to this source so two sources with overlapping meshes
    // each show only what they have actually heard. When no sourceId is given
    // (legacy/no-source callers), fall back to the global unscoped query.
    const allMemoryNodes = await activeManager.getAllNodesAsync(pollSourceId);
    const filteredMemoryNodes = await filterNodesByChannelPermission(allMemoryNodes, user, pollSourceId);

    // Load full permission set once to avoid N sequential DB queries per permission check
    const userPermissionSet = (user && !user.isAdmin && userId)
      ? await databaseService.getUserPermissionSetAsync(userId, pollSourceId)
      : null;
    // In-memory permission check using the pre-loaded permission set
    const checkPerm = (resource: string, action: 'read' | 'write'): boolean => {
      if (!user) return false;
      if (user.isAdmin) return true;
      return (userPermissionSet as Record<string, { read: boolean; write: boolean }> | null)?.[resource]?.[action] ?? false;
    };

    const hasChannelsRead = checkPerm('channel_0', 'read');
    const hasMessagesRead = checkPerm('messages', 'read');
    const hasInfoRead = checkPerm('info', 'read');
    const canViewPrivate = checkPerm('nodes_private', 'read');
    // Virtual (Channel Database) channels are gated by per-entry `canRead`
    // grants, not the channel_0..7 RBAC resources. Load them so a
    // virtual-channel-only caller (e.g. anonymous on an MQTT bridge) sees the
    // messages/channels feeding the per-source Channels tab.
    const readableVirtual = await getUserReadableVirtualChannelIds(user, user?.isAdmin === true);
    const hasVirtualRead = hasAnyReadableVirtualChannel(readableVirtual);

    // 1. Connection status (always available)
    // If the caller named a sourceId but the registry has no manager for it
    // (autoConnect=false, or user manually disconnected via
    // /api/sources/:id/disconnect — issue #2773), report a clean disconnected
    // state rather than leaking the legacy singleton's status.
    const sourceIdRequestedButNoManager =
      !!pollSourceId && !sourceManagerRegistry.getManager(pollSourceId);
    if (sourceIdRequestedButNoManager) {
      result.connection = {
        connected: false,
        nodeResponsive: false,
        configuring: false,
        userDisconnected: false,
      };
    } else {
      try {
        const connectionStatus = await activeManager.getConnectionStatus();
        // Hide nodeIp from anonymous users
        if (!req.session.userId) {
          const { nodeIp, ...statusWithoutNodeIp } = connectionStatus;
          result.connection = statusWithoutNodeIp;
        } else {
          result.connection = connectionStatus;
        }
      } catch (error) {
        logger.error('Error getting connection status in poll:', error);
        result.connection = { error: 'Failed to get connection status' };
      }
    }

    // 2. Nodes (always available with optionalAuth, filtered by channel permissions)
    try {
      const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();
      result.nodes = await Promise.all(filteredMemoryNodes.map(node => enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate)));
    } catch (error) {
      logger.error('Error fetching nodes in poll:', error);
      result.nodes = [];
    }

    // 3. Messages (requires any channel permission OR messages permission OR
    //    a readable virtual channel)
    try {
      if (hasChannelsRead || hasMessagesRead || hasVirtualRead) {
        // Scope messages to the requesting source. Per-source tabs must only
        // see messages their own source actually ingested — cross-source
        // visibility belongs in the dedicated unified views (/unified/messages).
        // When no sourceId is provided (legacy single-source clients), fall
        // back to the global fetch.
        // Exclude traceroute responses from the poll window. The UI filters
        // them out of message lists (they render from the `traceroutes`
        // table), so including them only wastes slots in the fixed-size
        // window and evicts real DMs (issue #2741).
        const dbMessagesRaw = pollSourceId
          ? await databaseService.messages.getMessages(100, 0, pollSourceId, [PortNum.TRACEROUTE_APP])
          : await databaseService.messages.getMessages(100, 0, undefined, [PortNum.TRACEROUTE_APP]);

        let messages: MeshMessage[] = dbMessagesRaw.map(
          msg => transformDbMessageToMeshMessage(msg as any as DbMessage)
        );

        // MM-SEC-3: pre-compute the per-channel authorized set so a caller
        // with `channel_0:read` no longer sees messages from hidden channels.
        // Sibling sections (channels, unread-counts) already do this — bring
        // messages in line.
        const isAdminCaller = user?.isAdmin === true;
        const authorizedChannelIds = new Set<number>();
        if (isAdminCaller) {
          for (let id = 0; id <= 7; id++) authorizedChannelIds.add(id);
        } else if (user) {
          for (let id = 0; id <= 7; id++) {
            if (checkPerm(`channel_${id}`, 'read')) authorizedChannelIds.add(id);
          }
        }

        // Filter:
        // - DMs (channel -1) require `messages:read`.
        // - Channel messages require BOTH `hasChannelsRead` AND
        //   per-channel `channel_${id}:read` for the message's actual channel.
        messages = messages.filter(msg => {
          if (msg.channel === -1) return hasMessagesRead;
          // Virtual channels use per-entry canRead, independent of channel_0..7.
          if (isVirtualChannelNumber(msg.channel)) {
            return canReadVirtualChannelNumber(msg.channel, readableVirtual);
          }
          return hasChannelsRead && (isAdminCaller || authorizedChannelIds.has(msg.channel));
        });

        result.messages = messages;
      }
    } catch (error) {
      logger.error('Error fetching messages in poll:', error);
    }

    // 4. Unread counts (requires channels OR messages permission)
    try {
      const unreadResult: {
        channels?: { [channelId: number]: number };
        directMessages?: { [nodeId: string]: number };
      } = {};

      // Get unread counts for all channels first
      // Only count incoming messages (exclude messages sent by our node).
      // Scope to the requesting source so per-source tabs only count messages
      // their own source ingested (issue: badge stays lit for messages that
      // aren't visible in the current tab).
      const allUnreadChannels = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId, pollSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted

      // Filter channels based on per-channel read permission
      const filteredUnreadChannels: { [channelId: number]: number } = {};
      for (const [channelIdStr, count] of Object.entries(allUnreadChannels)) {
        const channelId = parseInt(channelIdStr);
        // Virtual channels use per-entry canRead; physical channels use RBAC.
        const hasChannelRead = isVirtualChannelNumber(channelId)
          ? canReadVirtualChannelNumber(channelId, readableVirtual)
          : checkPerm(`channel_${channelId}` as import('../../types/permission.js').ResourceType, 'read');

        if (hasChannelRead) {
          filteredUnreadChannels[channelId] = count;
        }
      }
      unreadResult.channels = filteredUnreadChannels;

      // Batch DM unread counts (single query instead of N+1)
      if (hasMessagesRead && localNodeInfo) {
        const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId, pollSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted
        const visibleNodeIds = new Set(filteredMemoryNodes.map(n => n.user?.id).filter(Boolean));
        const directMessages: { [nodeId: string]: number } = {};
        for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
          if (visibleNodeIds.has(nodeId) && count > 0) {
            directMessages[nodeId] = count;
          }
        }
        unreadResult.directMessages = directMessages;
      }

      result.unreadCounts = unreadResult;
    } catch (error) {
      logger.error('Error fetching unread counts in poll:', error);
    }

    // 5. Channels (filtered based on per-channel read permissions)
    try {
      // intentional cross-source: omitting sourceId on the poll route returns channels from all sources
      const allChannels = await databaseService.channels.getAllChannels(pollSourceId ?? ALL_SOURCES);

      // Filter channels async
      const filteredChannels: typeof allChannels = [];
      for (const channel of allChannels) {
        // Exclude disabled channels (role === 0)
        if (channel.role === 0) {
          continue;
        }

        // Check per-channel read permission
        const channelResource = `channel_${channel.id}` as import('../../types/permission.js').ResourceType;
        const hasChannelRead = checkPerm(channelResource, 'read');

        if (!hasChannelRead) {
          continue; // User doesn't have permission to see this channel
        }

        // Show channel 0 (Primary channel) if user has permission
        if (channel.id === 0) {
          filteredChannels.push(channel);
          continue;
        }

        // Show channels 1-7 if they have a PSK configured (indicating they're in use)
        if (channel.id >= 1 && channel.id <= 7 && channel.psk) {
          filteredChannels.push(channel);
          continue;
        }

        // Show channels with a role defined (PRIMARY, SECONDARY)
        if (channel.role !== null && channel.role !== undefined) {
          filteredChannels.push(channel);
        }
      }

      // Ensure Primary channel (ID 0) is first in the list
      const primaryIndex = filteredChannels.findIndex(ch => ch.id === 0);
      if (primaryIndex > 0) {
        const primary = filteredChannels.splice(primaryIndex, 1)[0];
        filteredChannels.unshift(primary);
      }

      // MM-SEC-2: project through transformChannel so the raw `psk` column
      // is gated. The per-channel permission gate above already filters out
      // hidden channels; here we additionally include the actual key only
      // for callers with write permission to that specific channel (admins
      // automatically). See issue #2951 — the channel-config UI needs the
      // existing PSK to display in the edit dialog for authorized operators.
      result.channels = filteredChannels.map((channel) => {
        const includePsk = checkPerm(`channel_${channel.id}`, 'write');
        return transformChannel(channel, { includePsk });
      });
    } catch (error) {
      logger.error('Error fetching channels in poll:', error);
    }

    // 6. Telemetry availability (requires info:read permission, filtered by channel permissions)
    try {
      if (hasInfoRead) {
        // Use DB nodes for telemetry (has telemetryTypes), filtered by channel permissions
        // intentional cross-source: omitting sourceId on the poll route returns nodes from all sources
        const allDbNodes = await databaseService.nodes.getAllNodes(pollSourceId ?? ALL_SOURCES);
        const dbNodes = await filterNodesByChannelPermission(allDbNodes, req.user, pollSourceId);

        const nodesWithTelemetry: string[] = [];
        const nodesWithWeather: string[] = [];
        const nodesWithEstimatedPosition: string[] = [];
        const nodesUnmapped: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);

        // Use scoped repo call when sourceId provided (bypasses shared cache)
        const nodeTelemetryTypes = pollSourceId
          ? await databaseService.telemetry.getAllNodesTelemetryTypes(pollSourceId)
          : await databaseService.getAllNodesTelemetryTypesAsync();
        // Global estimated positions (pooled across all Meshtastic sources, #3271).
        const estimatedRows = await databaseService.getAllEstimatedPositionsAsync();
        const estimatedPositionMap = new Map(estimatedRows.map(r => [r.nodeId, r]));
        const estimatedUncertainty: Record<string, number> = {};

        dbNodes.forEach(node => {
          const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
          if (telemetryTypes && telemetryTypes.length > 0) {
            nodesWithTelemetry.push(node.nodeId);

            const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
            if (hasWeather) {
              nodesWithWeather.push(node.nodeId);
            }
          }

          // Estimated-position / unmapped status is independent of telemetry.
          // A user-set override counts as a known position (issue #2847).
          const eff = getEffectiveDbNodePosition(node);
          const hasRealPosition = eff.latitude != null && eff.longitude != null;
          const estimate = estimatedPositionMap.get(node.nodeId);
          const hasEstimatedPosition = estimate !== undefined;
          if (hasEstimatedPosition && !hasRealPosition) {
            nodesWithEstimatedPosition.push(node.nodeId);
            if (estimate.uncertaintyKm != null) {
              estimatedUncertainty[node.nodeId] = estimate.uncertaintyKm;
            }
          }
          if (!hasRealPosition && !hasEstimatedPosition) {
            nodesUnmapped.push(node.nodeId);
          }
        });

        const nodesWithPKC: string[] = [];
        dbNodes.forEach(node => {
          if (node.hasPKC || node.publicKey) {
            nodesWithPKC.push(node.nodeId);
          }
        });

        result.telemetryNodes = {
          nodes: nodesWithTelemetry,
          weather: nodesWithWeather,
          estimatedPosition: nodesWithEstimatedPosition,
          estimatedUncertainty,
          unmapped: nodesUnmapped,
          unmappedCount: nodesUnmapped.length,
          pkc: nodesWithPKC,
        };
      }
    } catch (error) {
      logger.error('Error checking telemetry availability in poll:', error);
    }

    // 7. Config (always available with optionalAuth)
    try {
      // Use the active manager's local node info — source-scoped, not the global settings key
      const managerNodeInfo = activeManager.getLocalNodeInfo();

      const deviceMetadata = managerNodeInfo ? {
        firmwareVersion: managerNodeInfo.firmwareVersion,
        rebootCount: managerNodeInfo.rebootCount,
        hasWifi: managerNodeInfo.hasWifi,
        hasEthernet: managerNodeInfo.hasEthernet,
        hasBluetooth: managerNodeInfo.hasBluetooth,
        // True when the node is reached via a bridge/proxy (no native IP) and
        // therefore cannot do OTA firmware updates. See isLocalNodeBridged().
        isBridged: activeManager.isLocalNodeBridged(),
      } : undefined;

      const pollLocalNodeInfo = managerNodeInfo ? {
        nodeId: managerNodeInfo.nodeId,
        longName: managerNodeInfo.longName,
        shortName: managerNodeInfo.shortName,
      } : undefined;

      // Source-scoped connection config (issue #2981). When the caller passes
      // a sourceId, return that source's host/port so OTA firmware updates
      // flash the right node instead of the env default (192.168.1.100).
      const conn = await resolveSourceConnectionConfig(pollSourceId);

      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: conn.host ?? '' } : {}),
        meshtasticTcpPort: conn.port ?? env.meshtasticTcpPort,
        meshtasticUseTls: false,
        meshtasticSourceType: conn.sourceType,
        baseUrl: BASE_URL,
        // Only expose node identity and device metadata to authenticated users
        ...(req.session.userId ? { deviceMetadata, localNodeInfo: pollLocalNodeInfo } : {}),
      };
    } catch (error) {
      logger.error('Error in config section of poll:', error);
      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL,
      };
    }

    // 8. Device config (requires configuration:read permission)
    try {
      const hasConfigRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'configuration', 'read') : false);
      if (hasConfigRead) {
        const config = await activeManager.getDeviceConfig();
        if (config) {
          // Hide node address from anonymous users
          if (!req.session.userId && config.basic) {
            const { nodeAddress, ...basicWithoutNodeAddress } = config.basic;
            result.deviceConfig = {
              ...config,
              basic: basicWithoutNodeAddress,
            };
          } else {
            result.deviceConfig = config;
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching device config in poll:', error);
    }

    // 9. Recent traceroutes (for dashboard widget and node view)
    try {
      const hoursParam = 24;
      const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

      // Calculate dynamic default limit based on settings
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      let limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);

      const allTraceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, pollSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted
      const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

      // Add hopCount for each traceroute
      const traceroutesWithHops = recentTraceroutes.map(tr => {
        let hopCount = 999;
        try {
          if (tr.route) {
            const routeArray = JSON.parse(tr.route);
            // Verify routeArray is actually an array before accessing .length
            if (Array.isArray(routeArray)) {
              hopCount = routeArray.length;
            }
            // If routeArray is not an array, hopCount remains 999
          }
        } catch (e) {
          hopCount = 999;
        }
        return { ...tr, hopCount };
      });

      result.traceroutes = traceroutesWithHops;
    } catch (error) {
      logger.error('Error fetching traceroutes in poll:', error);
    }

    // 10. Device node numbers (nodes in the connected radio's local database)
    result.deviceNodeNums = activeManager.getDeviceNodeNums();

    res.json(result);
  } catch (error) {
    logger.error('Error in consolidated poll endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch polling data' });
  }
});

export default router;
