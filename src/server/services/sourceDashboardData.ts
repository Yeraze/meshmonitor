/**
 * Shared builders for a source's dashboard datasets (nodes, channels,
 * traceroutes, neighbor-info).
 *
 * These were extracted verbatim from the per-dataset GET handlers in
 * `sourceRoutes.ts` so that both the individual endpoints AND the aggregate
 * dashboard endpoints (`GET /api/sources/:id/dashboard`,
 * `GET /api/unified/dashboard`) compute identical, identically-masked results.
 *
 * The aggregate endpoints exist to cut request volume: the dashboard used to
 * fire one GET per dataset per source on every 15s poll (4×N requests), which
 * exhausts the API rate limiter on multi-source setups and hammers low-powered
 * or busy servers (#3735). Bundling the four reads collapses that to one
 * request per source (or one for the whole unified view).
 *
 * Each builder takes the already-resolved `source` row and the request `user`
 * (may be null for anonymous, has `isAdmin`) and returns plain JSON-able data.
 * Permission gating that the individual routes did via `requirePermission`
 * middleware is applied per-dataset by `buildSourceDashboard`.
 */
import databaseService from '../../services/database.js';
import { hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';
import {
  filterNodesByChannelPermission,
  maskNodeLocationByChannel,
  maskTraceroutesByChannel,
  getEffectiveDbNodePosition,
} from '../utils/nodeEnhancer.js';
import { modemPresetChannelName, TransportMechanism } from '../constants/meshtastic.js';
import { transformChannel } from '../utils/channelView.js';
import type { ResourceType } from '../../types/permission.js';
import type { User } from '../../types/auth.js';

type SourceRow = { id: string; name: string; type: string };
// The request user (null when anonymous), as attached by optionalAuth/requirePermission.
type ReqUser = User | null;

/** Resolve the global `maxNodeAgeHours` setting (default 24). */
export async function getMaxNodeAgeHours(): Promise<number> {
  const raw = await databaseService.settings.getSetting('maxNodeAgeHours');
  return raw ? (parseInt(raw, 10) || 24) : 24;
}

/** Nodes for a source, channel-filtered and position-masked (mirrors GET /:id/nodes). */
export async function buildSourceNodes(source: SourceRow, user: ReqUser): Promise<unknown[]> {
  // MeshCore sources don't share the meshtastic node table — pull contacts
  // (and localNode) directly from the per-source MeshCoreManager and map
  // them into the dashboard's flat node shape. These return early and never
  // reach the position-override logic below: MeshCore contacts have no
  // override columns (that's a Meshtastic-node feature, #3551).
  if (source.type === 'meshcore') {
    const _raw = sourceManagerRegistry.getManager(source.id);
    const mcManager = _raw && isMeshCoreManager(_raw) ? _raw : null;
    const mcNodes: any[] = [];
    if (mcManager) {
      for (const n of await mcManager.getAllNodes()) {
        if (n.latitude == null || n.longitude == null) continue;
        if (n.latitude === 0 && n.longitude === 0) continue;
        const lastHeard = typeof n.lastHeard === 'number'
          ? Math.floor(n.lastHeard / 1000)
          : Math.floor(Date.now() / 1000);
        const pubKey = n.publicKey || '';
        const nodeId = `mc:${mcManager.sourceId}:${pubKey.substring(0, 12)}`;
        mcNodes.push({
          nodeId,
          nodeNum: 0,
          sourceId: mcManager.sourceId,
          isMeshCore: true,
          publicKey: pubKey,
          // MeshCore has no ignore concept (no isIgnored anywhere in
          // meshcoreManager), so false is accurate rather than a placeholder.
          isIgnored: false,
          // #4240 follow-up: this was hardcoded false, which silently dropped
          // the favorite flag `getAllNodes()` already returns from
          // meshcore_nodes.isFavorite (migration 094). Map filters gate on
          // `isFavorite || lastHeard >= cutoff`, so a favorited MeshCore node
          // lost its staleness-cutoff bypass and vanished from the map once it
          // aged past the window — the same symptom as #4240, different cause.
          isFavorite: n.isFavorite ?? false,
          user: { id: nodeId, longName: n.name, shortName: (n.name || '').substring(0, 4) },
          longName: n.name,
          shortName: (n.name || '').substring(0, 4),
          latitude: n.latitude,
          longitude: n.longitude,
          position: { latitude: n.latitude, longitude: n.longitude },
          lastHeard,
          hopsAway: 0,
          role: 0,
          advType: typeof n.advType === 'number' ? n.advType : 0,
        });
      }
    }
    return mcNodes;
  }

  // Nodes are stored per-source (composite PK (nodeNum, sourceId) since
  // migration 029). Filter strictly by this source.
  const nodes = await databaseService.nodes.getAllNodes(source.id);

  // The local node for this source may not be in DB yet (brand new device).
  const manager = sourceManagerRegistry.getManager(source.id);
  if (manager) {
    const localNodeInfo = manager.getLocalNodeInfo();
    if (localNodeInfo && localNodeInfo.nodeNum && !nodes.some(n => n.nodeNum === localNodeInfo.nodeNum)) {
      // Scope the lookup to THIS source. `getNode(nodeNum)` without a sourceId
      // does a cross-source first-match, which on a multi-source deployment can
      // inject another source's row (and its position) into this source's node
      // list when both have heard the same nodeNum (#3735 review). Per-source
      // scoping keeps the feed isolated; if this source hasn't stored the local
      // node yet, fall through to the synthesized minimal record below.
      const localNode = await databaseService.nodes.getNode(localNodeInfo.nodeNum, source.id);
      if (localNode) {
        nodes.push(localNode);
      } else {
        nodes.push({
          nodeNum: localNodeInfo.nodeNum,
          nodeId: localNodeInfo.nodeId,
          longName: localNodeInfo.longName,
          shortName: localNodeInfo.shortName,
          hwModel: localNodeInfo.hwModel ?? 0,
          lastHeard: Math.floor(Date.now() / 1000),
          sourceId: source.id,
        } as any);
      }
    }
  }

  // Filter by channel viewOnMap permissions and mask private position channels.
  const filtered = await filterNodesByChannelPermission(nodes, user, source.id);
  const masked = await maskNodeLocationByChannel(filtered, user, source.id);

  // Apply per-node position override to the flat lat/lng the dashboard map
  // reads (issue #3551). Private overrides are honored only for callers with
  // nodes_private read, and the override coords are stripped for everyone else.
  const canViewPrivate = user?.isAdmin
    ? true
    : (user ? await hasPermission(user, 'nodes_private', 'read') : false);
  const withOverride = masked.map(node => {
    const n = node as any;
    const isPrivate = n.positionOverrideIsPrivate === true;

    if (isPrivate && !canViewPrivate) {
      const stripped = { ...n };
      delete stripped.latitudeOverride;
      delete stripped.longitudeOverride;
      delete stripped.altitudeOverride;
      return stripped;
    }

    const eff = getEffectiveDbNodePosition(n);
    if (eff.isOverride) {
      return {
        ...n,
        latitude: eff.latitude,
        longitude: eff.longitude,
        altitude: eff.altitude,
        positionIsOverride: true,
      };
    }
    return n;
  });
  return withOverride;
}

/** Channels for a source, per-channel read-gated, PSK projected (mirrors GET /:id/channels). */
export async function buildSourceChannels(source: SourceRow, user: ReqUser): Promise<unknown[]> {
  const allChannels = await databaseService.channels.getAllChannels(source.id);
  const isAdmin = user?.isAdmin === true;

  // Resolve this source's persisted modem preset so empty-name slot 0 can
  // display as "MediumFast"/"LongFast" instead of the synthetic "Primary".
  let presetName: string | null = null;
  try {
    const raw = await databaseService.settings.getSetting(`lora.preset.${source.id}`);
    const n = raw != null ? Number(raw) : NaN;
    if (Number.isFinite(n)) presetName = modemPresetChannelName(n);
  } catch (err) {
    logger.debug(`Failed to load preset for source ${source.id}:`, err);
  }

  const accessible: typeof allChannels = [];
  for (const channel of allChannels) {
    if (isAdmin) {
      accessible.push(channel);
      continue;
    }
    const channelResource = `channel_${channel.id}` as ResourceType;
    if (user && await hasPermission(user, channelResource, 'read', source.id)) {
      accessible.push(channel);
    }
  }

  // Issue #2951: include the raw `psk` only for admins or callers with write
  // permission on the specific channel.
  const projected = await Promise.all(accessible.map(async (channel) => {
    const channelResource = `channel_${channel.id}` as ResourceType;
    const includePsk = isAdmin || (user
      ? await hasPermission(user, channelResource, 'write', source.id)
      : false);
    return transformChannel(channel, { includePsk, presetName });
  }));

  return projected;
}

/** Traceroutes for a source, channel-masked (mirrors GET /:id/traceroutes). */
export async function buildSourceTraceroutes(
  source: SourceRow,
  user: ReqUser,
  limit = 50,
): Promise<unknown[]> {
  const clamped = Math.min(limit, 200);
  const traceroutes = await databaseService.traceroutes.getAllTraceroutes(clamped, source.id);
  // Channel-gate traceroutes the same way nodes are gated so their embedded
  // routePositions don't draw segments for routes the user can't view (#3092).
  return maskTraceroutesByChannel(traceroutes, user, source.id);
}

/**
 * Enriched neighbor-info for a source, channel-gated (mirrors GET /:id/neighbor-info).
 *
 * `maxNodeAgeHours` is a GLOBAL setting; pass it in to avoid re-querying it once
 * per source when fanning out across many sources (the unified dashboard route
 * fetches it once). When omitted, it's fetched here so single-source callers
 * stay self-contained.
 */
export async function buildSourceNeighborInfo(
  source: SourceRow,
  user: ReqUser,
  maxNodeAgeHours?: number,
): Promise<unknown[]> {
  const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(source.id);

  const resolvedMaxAge = maxNodeAgeHours ?? await getMaxNodeAgeHours();
  const cutoffTime = Math.floor(Date.now() / 1000) - resolvedMaxAge * 60 * 60;

  const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

  const allNodeNums = [...new Set([
    ...neighborInfo.map(ni => ni.nodeNum),
    ...neighborInfo.map(ni => ni.neighborNodeNum),
  ])];
  // Scope node lookup to this source so transportMechanism reflects how THIS
  // source hears each node (not a different source's RF/MQTT classification).
  const nodeMap = await databaseService.nodes.getNodesByNums(allNodeNums, source.id);

  // Same channel gate the nodes endpoint uses, so a neighbor-info link whose
  // endpoint nodes the user can't see doesn't leak their positions (#3092).
  const visibleNodes = await filterNodesByChannelPermission(
    Array.from(nodeMap.values()),
    user,
    source.id,
  );
  const visibleNodeNums = new Set(visibleNodes.map(n => Number((n as any).nodeNum)));

  // Deduplicate bidirectional links: if both A→B and B→A are present, keep only
  // the canonical direction (smaller nodeNum first) to avoid two overlapping
  // polylines on the map. The bidirectional flag on the kept record signals that
  // both directions exist.
  const seenPairs = new Set<string>();

  // Directed-key lookup so the kept canonical record can surface the OTHER
  // direction's signal data in the map popup (issue #3777: clicking a link must
  // expose BOTH directions). The dedup above drops the reverse row, so capture
  // each directed observation here first. Keyed `${from}-${to}`.
  const byDirected = new Map<string, typeof neighborInfo[number]>();
  for (const ni of neighborInfo) {
    byDirected.set(`${ni.nodeNum}-${ni.neighborNodeNum}`, ni);
  }

  const enrichedNeighborInfo = neighborInfo
    .filter(ni =>
      visibleNodeNums.has(Number(ni.nodeNum)) &&
      visibleNodeNums.has(Number(ni.neighborNodeNum)),
    )
    .filter(ni => {
      // Canonical pair key: always smaller nodeNum first.
      const a = Math.min(ni.nodeNum, ni.neighborNodeNum);
      const b = Math.max(ni.nodeNum, ni.neighborNodeNum);
      const pairKey = `${a}-${b}`;
      if (seenPairs.has(pairKey)) return false;
      seenPairs.add(pairKey);
      return true;
    })
    .map(ni => {
      const node = nodeMap.get(ni.nodeNum) ?? null;
      const neighbor = nodeMap.get(ni.neighborNodeNum) ?? null;
      const nodePos = getEffectiveDbNodePosition(node);
      const neighborPos = getEffectiveDbNodePosition(neighbor);

      const nTx = (node as any)?.transportMechanism;
      const nbTx = (neighbor as any)?.transportMechanism;
      const isMqtt = nTx === TransportMechanism.MQTT || nbTx === TransportMechanism.MQTT
        || (node as any)?.viaMqtt || (neighbor as any)?.viaMqtt;
      const isUdp = nTx === TransportMechanism.MULTICAST_UDP || nbTx === TransportMechanism.MULTICAST_UDP;
      const transportClass: 'rf' | 'udp' | 'mqtt' = isMqtt ? 'mqtt' : isUdp ? 'udp' : 'rf';

      // The kept record's own snr/lastRxTime (spread from `...ni`) describe the
      // forward direction (nodeNum → neighborNodeNum). The reverse direction was
      // dropped by the dedup filter, so attach its signal data for the popup.
      const reverse = byDirected.get(`${ni.neighborNodeNum}-${ni.nodeNum}`);

      return {
        ...ni,
        nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
        nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        bidirectional: linkKeys.has(`${ni.neighborNodeNum}-${ni.nodeNum}`),
        reverseSnr: reverse?.snr ?? null,
        reverseTimestamp: reverse?.timestamp ?? null,
        transportClass,
        nodeLatitude: nodePos.latitude,
        nodeLongitude: nodePos.longitude,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
        node,
        neighbor,
      };
    })
    .filter(ni => {
      // Report-time freshness: show a neighbor edge only when its NeighborInfo
      // report falls within the window (matches GET /api/analysis/neighbors).
      const reportSec = Math.floor((ni.timestamp ?? 0) / 1000);
      return reportSec >= cutoffTime;
    })
    .map(({ node: _node, neighbor: _neighbor, ...rest }) => rest);

  return enrichedNeighborInfo;
}

export interface SourceDashboardPayload {
  sourceId: string;
  nodes: unknown[];
  traceroutes: unknown[];
  neighborInfo: unknown[];
  channels: unknown[];
}

/**
 * Aggregate the four dashboard datasets for a source in one shot, applying the
 * same per-dataset permission gating the individual routes enforced via
 * middleware:
 *   - nodes / neighborInfo → `nodes:read`
 *   - traceroutes          → `traceroute:read`
 *   - channels             → self-gated per-channel inside buildSourceChannels
 * A dataset the caller can't read comes back as `[]` (the individual route
 * would have 403'd; here we degrade gracefully so one missing grant doesn't
 * sink the whole dashboard).
 */
export async function buildSourceDashboard(
  source: SourceRow,
  user: ReqUser,
  opts?: { maxNodeAgeHours?: number },
): Promise<SourceDashboardPayload> {
  const isAdmin = user?.isAdmin === true;
  const canReadNodes = isAdmin || (user ? await hasPermission(user, 'nodes', 'read', source.id) : false);
  const canReadTraceroutes = isAdmin || (user ? await hasPermission(user, 'traceroute', 'read', source.id) : false);

  const [nodes, traceroutes, neighborInfo, channels] = await Promise.all([
    canReadNodes ? buildSourceNodes(source, user) : Promise.resolve([]),
    canReadTraceroutes ? buildSourceTraceroutes(source, user) : Promise.resolve([]),
    canReadNodes ? buildSourceNeighborInfo(source, user, opts?.maxNodeAgeHours) : Promise.resolve([]),
    buildSourceChannels(source, user),
  ]);

  return { sourceId: source.id, nodes, traceroutes, neighborInfo, channels };
}
