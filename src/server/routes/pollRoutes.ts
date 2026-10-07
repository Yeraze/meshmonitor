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
import type { DeviceInfo } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { resolveSourceManager, resolveOwnMeshtasticManager } from '../utils/resolveSourceManager.js';
import { isMqttConnectionStatusManager } from '../sourceManagerTypes.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import type { ResourceType } from '../../types/permission.js';
import {
  getUserReadableVirtualChannelIds,
  canReadVirtualChannelNumber,
  isVirtualChannelNumber,
  hasAnyReadableVirtualChannel,
} from '../utils/virtualChannelPermissions.js';
import { transformChannel } from '../utils/channelView.js';
import { enhanceNodeForClient, loadNodeViewAccess, getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { loadVisibleNodesAcrossSources } from '../services/nodeDbMaintenanceService.js';
import { getCachedSignFlipContext, applySignFlipCorrection, applySignFlipToTraceroute, applySignFlipToTraceroutes, rowSourceId } from '../services/signFlipCorrection.js';
import { PortNum } from '../constants/meshtastic.js';
import { transformDbMessageToMeshMessage } from '../utils/transformDbMessage.js';
import { resolveSourceConnectionConfig } from '../utils/resolveSourceConnectionConfig.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { mayViewSourceEndpointWith } from '../utils/sourceConfigRedaction.js';
import { getMaxNodeAgeHours } from '../services/nodeDisplaySettings.js';
import { holdsAnyGrantOn } from '../utils/sourcePermissions.js';

const env = getEnvironmentConfig();
const BASE_URL = env.baseUrl;

const router = express.Router();

/**
 * Every top-level key of the poll reply, with the gate a caller who is not an
 * admin must pass to get it. Admins get every section.
 *
 * Each gate is checked on the source the data comes from: the named source,
 * or, with no `sourceId`, each row's own source (rows) / the primary
 * Meshtastic source (the device sections). A grant on source A never passes
 * data of source B.
 *
 * `result` below is typed from this map, so a new key does not compile until
 * it is declared here, and `pollRoutes.scope.test.ts` fails on any key in a
 * reply that is not listed.
 */
export const POLL_SECTION_GATES = {
  connection: 'The four link flags: every caller (the app shell waits on `connected`). `nodeIp`: signed in with `sources:read`.',
  nodes: '`channel_N:viewOnMap` on the row\'s source, N = the channel the node was last heard on. A private position override: `nodes_private:read` on that source.',
  messages: 'Only with a `sourceId`. Channel messages: `channel_0:read` and `channel_N:read` on that source. DMs: `messages:read` on that source. Virtual channels: the per-entry `canRead` grant.',
  unreadCounts: 'Channel counts: `channel_N:read` on the source counted. DM counts: `messages:read` on that source, senders limited to visible nodes. Virtual channels: the per-entry `canRead` grant.',
  channels: '`channel_N:read` on the row\'s source. The PSK: `channel_N:write` on that source.',
  telemetryNodes: '`info:read` (a global resource), over the nodes the `nodes` rule shows.',
  config: '`baseUrl`, `meshtasticUseTls`, `meshtasticSourceType`: every caller. `meshtasticNodeIp` and the source\'s own `meshtasticTcpPort`: signed in with `sources:read`. `localNodeInfo`, `deviceMetadata`: signed in and holding any grant on that source.',
  deviceConfig: '`configuration:read` on the device\'s source.',
  traceroutes: '`traceroute:read` on the row\'s source, and `viewOnMap` on the row\'s channel there when it has one.',
  deviceNodeNums: 'The device\'s node numbers the `nodes` rule shows on that source.',
} as const;

export type PollSection = keyof typeof POLL_SECTION_GATES;

const DEVICE_CHANNEL_IDS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const channelResource = (id: number): ResourceType => `channel_${id}` as ResourceType;

// Consolidated polling endpoint - reduces multiple API calls to one
router.get('/poll', optionalAuth(), async (req, res) => {
  logger.debug('🔔 [POLL] Endpoint called');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- section payloads are built from untyped rows, as before
    const result: { [K in PollSection]?: any } = {};

    // Optional sourceId scoping — when provided, use the matching manager and filter DB queries
    const pollSourceId = (typeof req.query.sourceId === 'string' && req.query.sourceId) || undefined;
    const activeManager = resolveSourceManager(pollSourceId);
    // The local device's identity/config must come from THIS source's own
    // Meshtastic manager. resolveSourceManager() hands an mqtt_broker /
    // mqtt_bridge / meshcore id (or a source with no live manager) the
    // PRIMARY TCP manager, so the Info tab of an MQTT broker showed another
    // source's node ID, name, firmware and LoRa config (#5367). null here
    // means "this source has no local node": those sections stay empty.
    const deviceManager = resolveOwnMeshtasticManager(pollSourceId);

    // Pre-compute shared values used across multiple sections
    const user = req.user ?? null;
    const userId = user?.id ?? null;
    // The caller's grants, loaded ONCE (no query for an admin). Every check
    // below is answered from them in memory, for the source the data is from:
    // this route runs for every client every few seconds.
    const [access, readableVirtual] = await Promise.all([
      loadNodeViewAccess(user),
      // Virtual (Channel Database) channels are gated by per-entry `canRead`
      // grants, not the channel_0..7 RBAC resources, and are global by design.
      getUserReadableVirtualChannelIds(user, user?.isAdmin === true),
    ]);
    const permissions = access.permissions;
    const isAdmin = access.isAdmin;
    const hasVirtualRead = hasAnyReadableVirtualChannel(readableVirtual);
    /** `resource:action` on one source. False for "no source" unless admin. */
    const can = (resource: ResourceType, action: 'read' | 'write' | 'viewOnMap', sourceId: string | null | undefined): boolean =>
      isAdmin || (!!sourceId && permissions.can(resource, action, sourceId));
    // No source named and not an admin: the reply is built from the sources
    // the caller holds the section's grant on, each row checked on its own
    // source. Grants used to be merged across sources and applied to rows
    // merged from all of them.
    const acrossPermitted = !pollSourceId && !isAdmin;
    // Checked once: both the connection status and the config block carry the
    // node address.
    const mayViewEndpoint = mayViewSourceEndpointWith(user, permissions);
    // Unread DM counting keys off THIS source's own node. A source with no
    // local node (MQTT broker/bridge) skips DM-to-local counting instead of
    // counting the primary TCP node's DMs (#5375).
    const localNodeInfo = deviceManager?.getLocalNodeInfo() ?? null;
    // The source the device sections (config identity, deviceConfig,
    // deviceNodeNums) describe: the named one, else the primary.
    const deviceSourceId = pollSourceId ?? deviceManager?.sourceId ?? null;

    // Nodes are stored per-source (composite PK (nodeNum, sourceId) since migration
    // 029). Scope strictly to this source so two sources with overlapping meshes
    // each show only what they have actually heard.
    let visibleNodes: DeviceInfo[];
    // What `enhanceNodeForClient` may show of a private position override.
    let canViewPrivate: boolean;
    // Node ids / numbers the caller may see, per source. Filled only for the
    // across-sources read; a one-source read uses `visibleNodes`.
    const visibleIdsBySource = new Map<string, Set<string>>();
    const visibleNumsBySource = new Map<string, Set<number>>();
    // False when the caller holds no node grant on the named source: its node
    // rows are then not read at all.
    const mayHoldNodes = isAdmin || !pollSourceId || access.sources === 'all' || access.sources.includes(pollSourceId);
    if (!acrossPermitted) {
      // One source, or an admin's unified view: one read, as before.
      const allMemoryNodes = mayHoldNodes ? await activeManager.getAllNodesAsync(pollSourceId) : [];
      visibleNodes = isAdmin
        ? allMemoryNodes
        : allMemoryNodes.filter((node) => access.canViewNode(pollSourceId, (node as { channel?: number }).channel));
      canViewPrivate = access.canViewPrivate(pollSourceId);
    } else {
      // Rows the caller may not see are dropped, and a private override they
      // may not see removed, BEFORE the per-node merge, so nothing from such a
      // row is back-filled into the merged one (same as GET /api/nodes).
      visibleNodes = await loadVisibleNodesAcrossSources(
        access.sources === 'all' ? ALL_SOURCES : access.sources,
        (row) => {
          const rowSource = rowSourceId(row);
          if (!rowSource || !access.canViewNode(rowSource, row.channel)) return null;
          if (!visibleIdsBySource.has(rowSource)) {
            visibleIdsBySource.set(rowSource, new Set());
            visibleNumsBySource.set(rowSource, new Set());
          }
          visibleIdsBySource.get(rowSource)!.add(row.nodeId);
          visibleNumsBySource.get(rowSource)!.add(Number(row.nodeNum));
          if (row.positionOverrideIsPrivate && !access.canViewPrivate(rowSource)) {
            return {
              ...row,
              positionOverrideEnabled: false,
              latitudeOverride: undefined,
              longitudeOverride: undefined,
              altitudeOverride: undefined,
            };
          }
          return row;
        },
      );
      canViewPrivate = true;
    }
    /** Node ids visible on one source (DM senders whose counts may be shown). */
    const visibleNodeIdsOn = (sourceId: string | undefined): Set<string> =>
      acrossPermitted
        ? (sourceId && visibleIdsBySource.get(sourceId)) || new Set<string>()
        : new Set(visibleNodes.map((n) => n.user?.id).filter((id): id is string => typeof id === 'string'));

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
        // resolveSourceManager only narrows to meshtastic_tcp managers
        // (see its docstring, invariant I2, #3962 Phase 4.2a) — an
        // mqtt_bridge/mqtt_broker source is registered but not a
        // MeshtasticManager, so it silently falls back to the
        // primary/fallback manager and reports THAT manager's connection
        // state instead of its own. Look the MQTT manager up directly via
        // the registry, mirroring the MeshCore-narrowing pattern in
        // channelRoutes.ts.
        const rawPollManager = pollSourceId ? sourceManagerRegistry.getManager(pollSourceId) : null;
        const connectionStatusManager =
          rawPollManager && isMqttConnectionStatusManager(rawPollManager) ? rawPollManager : activeManager;
        const connectionStatus = await connectionStatusManager.getConnectionStatus();
        // The node address is a connection endpoint — see mayViewSourceEndpoint.
        if (!mayViewEndpoint) {
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
      // Both global by design: estimates are pooled across sources (#3271) and
      // the tracked-asset flag is per node (#5354). Each is attached only to a
      // node the caller may already see.
      const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();
      const assets = await databaseService.getAssetNodesMapAsync();
      const enhanced = await Promise.all(visibleNodes.map(node => enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate, assets)));
      // #5363: display-only sign-flip correction against this source's reference.
      // Cached (60 s, cleared by a settings save): this runs on every poll tick.
      const signFlipCtx = await getCachedSignFlipContext(pollSourceId);
      result.nodes = enhanced.map(node => applySignFlipCorrection(node, signFlipCtx));
    } catch (error) {
      logger.error('Error fetching nodes in poll:', error);
      result.nodes = [];
    }

    // 3. Messages (requires any channel permission OR messages permission OR
    //    a readable virtual channel), for a NAMED source only.
    //
    // Per-source tabs must only see messages their own source ingested;
    // cross-source reading belongs to the unified views (/unified/messages).
    // With no sourceId this section has been absent for every caller since
    // `withSourceScope` began refusing a missing source: the read threw and
    // was logged on each poll. It is now skipped outright.
    try {
      const hasChannelsRead = can('channel_0', 'read', pollSourceId);
      const hasMessagesRead = can('messages', 'read', pollSourceId);
      if (pollSourceId && (hasChannelsRead || hasMessagesRead || hasVirtualRead)) {
        // Exclude traceroute responses from the poll window. The UI filters
        // them out of message lists (they render from the `traceroutes`
        // table), so including them only wastes slots in the fixed-size
        // window and evicts real DMs (issue #2741).
        const dbMessagesRaw = await databaseService.messages.getMessages(100, 0, pollSourceId, [PortNum.TRACEROUTE_APP]);

        let messages: MeshMessage[] = dbMessagesRaw.map(
          msg => transformDbMessageToMeshMessage(msg as any as DbMessage)
        );

        // MM-SEC-3: a caller with `channel_0:read` must not see messages from
        // channels they cannot read. Checked on this source.
        const authorizedChannelIds = new Set<number>(
          DEVICE_CHANNEL_IDS.filter((id) => can(channelResource(id), 'read', pollSourceId)),
        );

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
          return hasChannelsRead && (isAdmin || authorizedChannelIds.has(msg.channel));
        });

        result.messages = messages;
      }
    } catch (error) {
      logger.error('Error fetching messages in poll:', error);
    }

    // 4. Unread counts (requires channels OR messages permission)
    try {
      type Unread = { channels: { [channelId: number]: number }; directMessages?: { [nodeId: string]: number } };

      /**
       * Unread counts of ONE source under the caller's grants on that source.
       * `sourceId` undefined is the admin's every-source read. `localNode` is
       * that source's own node: only incoming messages are counted, and DMs are
       * counted to it.
       */
      const unreadFor = async (sourceId: string | undefined, localNode: { nodeId: string } | null): Promise<Unread> => {
        // Scope to the source so per-source tabs only count messages their own
        // source ingested (a badge must not stay lit for messages that are not
        // visible in the current tab).
        const scope = sourceId ?? ALL_SOURCES; // cross-source only for an admin with no sourceId
        const allUnreadChannels = await databaseService.getUnreadCountsByChannelAsync(userId, localNode?.nodeId, scope);
        const unread: Unread = { channels: {} };
        for (const [channelIdStr, count] of Object.entries(allUnreadChannels)) {
          const channelId = parseInt(channelIdStr);
          // Virtual channels use per-entry canRead; physical channels use RBAC.
          const hasChannelRead = isVirtualChannelNumber(channelId)
            ? canReadVirtualChannelNumber(channelId, readableVirtual)
            : can(channelResource(channelId), 'read', sourceId);
          if (hasChannelRead) unread.channels[channelId] = count;
        }
        // Batch DM unread counts (single query instead of N+1)
        if (can('messages', 'read', sourceId) && localNode) {
          const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNode.nodeId, userId, scope);
          const visibleNodeIds = visibleNodeIdsOn(sourceId);
          const directMessages: { [nodeId: string]: number } = {};
          for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
            if (visibleNodeIds.has(nodeId) && count > 0) directMessages[nodeId] = count;
          }
          unread.directMessages = directMessages;
        }
        return unread;
      };

      if (!acrossPermitted) {
        result.unreadCounts = await unreadFor(pollSourceId, localNodeInfo);
      } else {
        // The sum over the sources the caller may read, each counted under its
        // own grants and against its own local node (as GET
        // /api/messages/unread-counts does). Two queries per such source.
        const candidates = hasVirtualRead
          ? (await databaseService.sources.getAllSources()).map((source) => source.id)
          : permissions.sourcesWhere((grants) =>
              grants.messages?.read === true || DEVICE_CHANNEL_IDS.some((id) => grants[channelResource(id)]?.read === true));
        const perSource = await Promise.all(candidates.map((id) =>
          unreadFor(id, resolveOwnMeshtasticManager(id)?.getLocalNodeInfo() ?? null)));
        const total: Unread = { channels: {} };
        for (const unread of perSource) {
          for (const [id, count] of Object.entries(unread.channels)) {
            total.channels[Number(id)] = (total.channels[Number(id)] ?? 0) + count;
          }
          if (unread.directMessages) {
            total.directMessages ??= {};
            for (const [nodeId, count] of Object.entries(unread.directMessages)) {
              total.directMessages[nodeId] = (total.directMessages[nodeId] ?? 0) + count;
            }
          }
        }
        result.unreadCounts = total;
      }
    } catch (error) {
      logger.error('Error fetching unread counts in poll:', error);
    }

    // 5. Channels (filtered based on per-channel read permissions)
    try {
      // One source when named, every source for an admin, else only the
      // sources the caller holds a channel read grant on.
      const channelScope = pollSourceId
        ?? (isAdmin
          ? ALL_SOURCES
          : permissions.sourcesWhere((grants) => DEVICE_CHANNEL_IDS.some((id) => grants[channelResource(id)]?.read === true)));
      const allChannels = await databaseService.channels.getAllChannels(channelScope);
      /** The source a channel row belongs to: its own, else the one named. */
      const channelSource = (channel: (typeof allChannels)[number]): string | undefined => rowSourceId(channel) ?? pollSourceId;

      const filteredChannels: typeof allChannels = [];
      for (const channel of allChannels) {
        // Exclude disabled channels (role === 0)
        if (channel.role === 0) {
          continue;
        }

        // Per-channel read permission, checked on the row's own source.
        if (!can(channelResource(channel.id), 'read', channelSource(channel))) {
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
      // for callers with write permission to that specific channel ON ITS
      // SOURCE (admins automatically). See issue #2951 — the channel-config
      // UI needs the existing PSK to display in the edit dialog for
      // authorized operators.
      result.channels = filteredChannels.map((channel) => {
        const includePsk = can(channelResource(channel.id), 'write', channelSource(channel));
        return transformChannel(channel, { includePsk });
      });
    } catch (error) {
      logger.error('Error fetching channels in poll:', error);
    }

    // 6. Telemetry availability (requires info:read permission, filtered by channel permissions)
    try {
      // `info` is a global resource: answered the way `requirePermission('info',
      // 'read')` answers it on GET /api/telemetry/available/nodes.
      if (isAdmin || permissions.can('info', 'read', pollSourceId ?? '')) {
        // Use DB nodes for telemetry (has telemetryTypes). One source when
        // named, every source for an admin, else the sources the caller holds
        // a channel grant on; each row is then checked on its own source.
        const nodeScope = pollSourceId ?? (access.sources === 'all' ? ALL_SOURCES : access.sources);
        const allDbNodes = mayHoldNodes ? await databaseService.nodes.getAllNodes(nodeScope) : [];
        const dbNodes = isAdmin
          ? allDbNodes
          : allDbNodes.filter((node) => access.canViewNode(rowSourceId(node) ?? pollSourceId, node.channel));
        // Telemetry is read from the sources of the rows kept, so a node seen
        // on source A is not marked from telemetry only source B holds.
        const telemetrySources = [...new Set(dbNodes.map((node) => rowSourceId(node)).filter((id): id is string => !!id))];

        const nodesWithTelemetry: string[] = [];
        const nodesWithWeather: string[] = [];
        const nodesWithEstimatedPosition: string[] = [];
        const nodesUnmapped: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);

        // Use scoped repo call when sourceId provided (bypasses shared cache).
        // The cached every-source map is for an admin only.
        const nodeTelemetryTypes = pollSourceId
          ? await databaseService.telemetry.getAllNodesTelemetryTypes(pollSourceId)
          : isAdmin
            ? await databaseService.getAllNodesTelemetryTypesAsync()
            : await databaseService.telemetry.getAllNodesTelemetryTypes(telemetrySources);
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
          // A private override the caller may not see is not a known position
          // for them, as in the nodes section.
          const hidesOverride = !isAdmin && !!node.positionOverrideIsPrivate
            && !access.canViewPrivate(rowSourceId(node) ?? pollSourceId);
          const eff = getEffectiveDbNodePosition(hidesOverride ? { ...node, positionOverrideEnabled: false } : node);
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
      // Use this source's own manager's local node info — source-scoped, not
      // the global settings key, and never another source's node (#5367).
      const managerNodeInfo = deviceManager ? deviceManager.getLocalNodeInfo() : null;

      const deviceMetadata = managerNodeInfo && deviceManager ? {
        firmwareVersion: managerNodeInfo.firmwareVersion,
        rebootCount: managerNodeInfo.rebootCount,
        hasWifi: managerNodeInfo.hasWifi,
        hasEthernet: managerNodeInfo.hasEthernet,
        hasBluetooth: managerNodeInfo.hasBluetooth,
        // True when the node is reached via a bridge/proxy (no native IP) and
        // therefore cannot do OTA firmware updates. See isLocalNodeBridged().
        isBridged: deviceManager.isLocalNodeBridged(),
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

      // The local node's identity and firmware describe one source: signed
      // in, and holding some grant on that source. Signed in alone used to be
      // enough, so naming a source showed its node to a user with no access
      // to it.
      const mayViewDevice = !!req.session.userId && (isAdmin || holdsAnyGrantOn(permissions, deviceSourceId));

      result.config = {
        ...(mayViewEndpoint ? { meshtasticNodeIp: conn.host ?? '' } : {}),
        // The source's own port is part of its endpoint; everyone else gets
        // the default.
        meshtasticTcpPort: mayViewEndpoint ? conn.port ?? env.meshtasticTcpPort : env.meshtasticTcpPort,
        meshtasticUseTls: false,
        meshtasticSourceType: conn.sourceType,
        baseUrl: BASE_URL,
        ...(mayViewDevice ? { deviceMetadata, localNodeInfo: pollLocalNodeInfo } : {}),
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

    // 8. Device config (requires configuration:read permission on the
    //    device's own source: a grant on another source is not one here)
    try {
      const hasConfigRead = can('configuration', 'read', deviceSourceId);
      if (hasConfigRead && deviceManager) {
        const config = await deviceManager.getDeviceConfig();
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
      const maxNodeAgeHours = await getMaxNodeAgeHours(databaseService.settings, pollSourceId ?? null);
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      let limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);

      const signFlipCtxForTraceroutes = await getCachedSignFlipContext(pollSourceId); // #5363
      // `traceroute:read` on the row's source, the gate of GET
      // /api/sources/:id/traceroutes. This section had no gate at all. One
      // source when named, every source for an admin, else the sources the
      // caller holds it on.
      const tracerouteScope = pollSourceId
        ?? (isAdmin ? ALL_SOURCES : permissions.sourcesWhere((grants) => grants.traceroute?.read === true));
      // For a named source this is the gate. With none named the scope above
      // already holds only permitted sources (an empty list reads nothing).
      const mayReadScope = isAdmin || !pollSourceId || can('traceroute', 'read', pollSourceId);
      const allTraceroutes = mayReadScope
        ? await databaseService.traceroutes.getAllTraceroutes(limit, tracerouteScope)
        : [];
      const recentTraceroutes = allTraceroutes.filter((tr) => {
        if (tr.timestamp < cutoffTime) return false;
        if (isAdmin) return true;
        // `traceroute:read` on the row's source is already decided: the query
        // read only the sources the caller holds it on.
        const trSource = rowSourceId(tr) ?? pollSourceId;
        // Channel-gate the way nodes are gated, so a route heard on a channel
        // the caller cannot view is not drawn (#3092). A row with no channel
        // recorded has no channel restriction.
        const channel = (tr as { channel?: number | null }).channel;
        return channel === undefined || channel === null || access.canViewNode(trSource, channel);
      });

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

      // #5363: stored routePositions snapshots drawn at the corrected point.
      // A scoped poll has one source, so reuse the cached context; an unscoped
      // one spans sources and resolves each row's own.
      result.traceroutes = pollSourceId
        ? traceroutesWithHops.map(tr => applySignFlipToTraceroute(tr, signFlipCtxForTraceroutes))
        : await applySignFlipToTraceroutes(traceroutesWithHops);
    } catch (error) {
      logger.error('Error fetching traceroutes in poll:', error);
    }

    // 10. Device node numbers (nodes in the connected radio's local database)
    // For a caller who is not an admin: only the ones they may see as nodes
    // on that source. The full list used to go to every caller.
    const deviceNodeNums = deviceManager ? deviceManager.getDeviceNodeNums() : [];
    if (isAdmin) {
      result.deviceNodeNums = deviceNodeNums;
    } else {
      const visibleNums = acrossPermitted
        ? (deviceSourceId && visibleNumsBySource.get(deviceSourceId)) || new Set<number>()
        : new Set(visibleNodes.map((node) => Number(node.nodeNum)));
      result.deviceNodeNums = deviceNodeNums.filter((nodeNum) => visibleNums.has(Number(nodeNum)));
    }

    res.json(result);
  } catch (error) {
    logger.error('Error in consolidated poll endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch polling data' });
  }
});

export default router;
