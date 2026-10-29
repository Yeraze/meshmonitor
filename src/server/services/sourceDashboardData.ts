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
import { applyMeshCorePositionOverridesForViewer } from '../utils/meshcorePositionOverride.js';
import { hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isAnyMeshCoreSourceType } from '../../utils/nodeTypeCategory.js';
import { isAnyMeshCoreManager } from '../sourceManagerTypes.js';
import {
  filterNodesByChannelPermission,
  maskNodeLocationByChannel,
  maskTraceroutesByChannel,
  getEffectiveDbNodePosition,
} from '../utils/nodeEnhancer.js';
import { modemPresetChannelName, TransportMechanism } from '../constants/meshtastic.js';
import { transformChannel } from '../utils/channelView.js';
import { getMaxNodeAgeHours } from './nodeDisplaySettings.js';
import { DASHBOARD_OMITTED_NODE_FIELDS } from '../../utils/dashboardNodeFields.js';
import { unifiedNodeKey } from '../../utils/nodeIdentity.js';
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  MAX_INFRA_NODE_AGE_HOURS_DEFAULT,
  parseNodeDisplayNumber,
  parseMaxInfraNodeAgeHours,
} from '../../constants/nodeDisplayDefaults.js';
import { effectiveIsMobile } from '../../utils/assetTracking.js';
import { loadSignFlipContext, applySignFlipCorrection, getDisplayDbNodePosition, applySignFlipToTraceroute } from './signFlipCorrection.js';
import type { ResourceType } from '../../types/permission.js';
import type { LiveNodeFilter } from '../../db/repositories/nodes.js';
import type { DbNode } from '../../db/types.js';
import type { User } from '../../types/auth.js';

type SourceRow = { id: string; name: string; type: string };
// The request user (null when anonymous), as attached by optionalAuth/requirePermission.
type ReqUser = User | null;

/**
 * Omitted fields that buildSourceNodes still reads while it filters and masks
 * (position-channel masking, the position override, the private-override
 * strip). They are read from the database and dropped at the end.
 */
const DASHBOARD_PROCESSING_FIELDS = new Set([
  'positionChannel',
  'latitudeOverride', 'longitudeOverride', 'altitudeOverride',
  'positionOverrideEnabled', 'positionOverrideIsPrivate',
  'aircraftFixedLatitude', 'aircraftFixedLongitude',
]);
const DASHBOARD_OMITTED_SET = new Set(DASHBOARD_OMITTED_NODE_FIELDS);
const DASHBOARD_UNSELECTED_COLUMNS = DASHBOARD_OMITTED_NODE_FIELDS.filter(
  (k) => !DASHBOARD_PROCESSING_FIELDS.has(k),
);

/** Copy of `node` without the DASHBOARD_OMITTED_NODE_FIELDS keys. */
function omitDashboardFields(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in node) {
    if (!DASHBOARD_OMITTED_SET.has(k)) out[k] = node[k];
  }
  return out;
}

/**
 * Nodes for a source, channel-filtered and position-masked (mirrors GET /:id/nodes).
 *
 * `slim` (the dashboard bundles) leaves out DASHBOARD_OMITTED_NODE_FIELDS.
 * Filtering and masking run on the same rows either way.
 */
export async function buildSourceNodes(
  source: SourceRow,
  user: ReqUser,
  opts?: { slim?: boolean },
): Promise<unknown[]> {
  return (await buildSourceNodesCounted(source, user, opts)).nodes;
}

/**
 * buildSourceNodes, plus the row count before a `liveOnly` read.
 *
 * `liveOnly` (the dashboard age cut, Meshtastic sources only) reads just the
 * rows of nodes with a live row in its sources, instead of every row, and
 * returns `uncutCount`: how many rows the channel filter passes over the whole
 * source, i.e. `nodes.length` without `liveOnly`.
 */
async function buildSourceNodesCounted(
  source: SourceRow,
  user: ReqUser,
  opts?: { slim?: boolean; liveOnly?: LiveNodeFilter },
): Promise<{ nodes: unknown[]; uncutCount?: number }> {
  const slim = opts?.slim === true;
  // MeshCore sources don't share the meshtastic node table — pull contacts
  // (and localNode) directly from the per-source MeshCoreManager and map
  // them into the dashboard's flat node shape. These return early and never
  // reach the Meshtastic position-override logic below; MeshCore contacts get
  // their own override (#5842) through applyMeshCorePositionOverridesForViewer.
  // isAnyMeshCoreSourceType, not === 'meshcore' (#5094): this outer gate was
  // the reason the isAnyMeshCoreManager narrow below never ran for an ingest
  // source. The comment there described behaviour this line prevented.
  if (isAnyMeshCoreSourceType(source.type)) {
    // Mirror the Meshtastic path below: canRead("nodes") makes the contact
    // list available, but publishing positions on the map additionally
    // requires viewOnMap("nodes") — MeshCore has no per-channel granularity
    // here, so this is a single per-source check rather than per-node
    // (#4559). Admins bypass, as everywhere else in this file.
    const canViewOnMap = user ? await hasPermission(user, 'nodes', 'viewOnMap', source.id) : false;
    if (!canViewOnMap) {
      return { nodes: [] };
    }

    const _raw = sourceManagerRegistry.getManager(source.id);
    // isAnyMeshCoreManager, not isMeshCoreManager (#5040 Phase 5.5): an MQTT
    // ingest source discovers nodes from adverts and has positions for them.
    // Narrowing device-only meant those never reached the map.
    const mcManager = _raw && isAnyMeshCoreManager(_raw) ? _raw : null;
    const mcNodes: any[] = [];
    // #5363: display-only sign-flip correction against this source's reference.
    const mcSignFlipCtx = mcManager ? await loadSignFlipContext(source.id) : null;
    if (mcManager) {
      // #5842: an enabled location override wins over the advert position.
      for (const n of await applyMeshCorePositionOverridesForViewer(await mcManager.getAllNodes(), user, source.id)) {
        if (n.latitude == null || n.longitude == null) continue;
        if (n.latitude === 0 && n.longitude === 0) continue;
        const lastHeard = typeof n.lastHeard === 'number'
          ? Math.floor(n.lastHeard / 1000)
          : Math.floor(Date.now() / 1000);
        const pubKey = n.publicKey || '';
        const nodeId = `mc:${mcManager.sourceId}:${pubKey.substring(0, 12)}`;
        mcNodes.push(applySignFlipCorrection({
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
          ...(n.positionIsOverride ? { positionIsOverride: true } : {}),
          lastHeard,
          hopsAway: 0,
          role: 0,
          advType: typeof n.advType === 'number' ? n.advType : 0,
          // #5578: lets the map hide a node whose latest advert had no
          // position (`false`), unless the fix is a live telemetry one. An
          // override (#5842) is a known location, so it never hides.
          lastAdvertHadPosition: n.positionIsOverride ? null : n.lastAdvertHadPosition ?? null,
          positionSource: n.positionSource ?? null,
        }, mcSignFlipCtx));
      }
    }
    return { nodes: mcNodes };
  }

  // Nodes are stored per-source (composite PK (nodeNum, sourceId) since
  // migration 029). Filter strictly by this source.
  const liveOnly = opts?.liveOnly;
  const [nodes, channelCounts] = await Promise.all([
    databaseService.nodes.getAllNodes(source.id, {
      ...(slim ? { omitColumns: DASHBOARD_UNSELECTED_COLUMNS } : {}),
      ...(liveOnly ? { liveAcross: liveOnly } : {}),
    }),
    liveOnly ? databaseService.nodes.countNodesByChannel(source.id) : Promise.resolve(null),
  ]);
  let synthesizedLocal: DbNode | null = null;

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
        synthesizedLocal = {
          nodeNum: localNodeInfo.nodeNum,
          nodeId: localNodeInfo.nodeId,
          longName: localNodeInfo.longName,
          shortName: localNodeInfo.shortName,
          hwModel: localNodeInfo.hwModel ?? 0,
          lastHeard: Math.floor(Date.now() / 1000),
          sourceId: source.id,
        } as unknown as DbNode;
        nodes.push(synthesizedLocal);
      }
    }
  }

  // Filter by channel viewOnMap permissions and mask private position channels.
  const filtered = await filterNodesByChannelPermission(nodes, user, source.id);
  // Same filter over one stand-in row per channel: it reads only `channel`.
  let uncutCount: number | undefined;
  if (channelCounts) {
    const passing = await filterNodesByChannelPermission(channelCounts, user, source.id);
    uncutCount = passing.reduce((sum, g) => sum + g.count, 0)
      + (synthesizedLocal !== null && filtered.includes(synthesizedLocal) ? 1 : 0);
  }
  const masked = await maskNodeLocationByChannel(filtered, user, source.id);

  // Apply per-node position override to the flat lat/lng the dashboard map
  // reads (issue #3551). Private overrides are honored only for callers with
  // nodes_private read ON THIS SOURCE, and the override coords are stripped
  // for everyone else. Checked with no source, a grant on any other source
  // passed.
  const canViewPrivate = user?.isAdmin
    ? true
    : (user ? await hasPermission(user, 'nodes_private', 'read', source.id) : false);
  const withOverride = masked.map(node => {
    const n = node as any;
    const isPrivate = n.positionOverrideIsPrivate === true;

    if (isPrivate && !canViewPrivate) {
      const stripped = { ...n };
      delete stripped.latitudeOverride;
      delete stripped.longitudeOverride;
      delete stripped.altitudeOverride;
      // The aircraft "fixed" anchor may be the private override itself (#5364/#5365 P2).
      delete stripped.aircraftFixedLatitude;
      delete stripped.aircraftFixedLongitude;
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

  // #5363: display-only sign-flip correction. Runs after the override step so
  // an override (positionIsOverride) is never touched. Meshtastic only: the
  // MeshCore branch above returns early.
  const signFlipCtx = await loadSignFlipContext(source.id);

  // Tracked-asset overlay (#5354): these rows skip enhanceNodeForClient, so
  // attach `asset` and the effective `isMobile` here. Keep in step with the
  // overlay in enhanceNodeForClient. Computed only: the raw `mobile` column is
  // passed through untouched.
  const assets = await databaseService.getAssetNodesMapAsync();
  const out = withOverride.map((node) => {
    const n = applySignFlipCorrection(node, signFlipCtx) as typeof node & { nodeNum?: unknown; mobile?: unknown };
    const entry = assets.get(Number(n.nodeNum));
    const asset = entry ? { retentionDays: entry.retentionDays } : undefined;
    const base = slim ? omitDashboardFields(n as Record<string, unknown>) : n;
    return { ...base, asset, isMobile: effectiveIsMobile(n.mobile, asset) };
  });
  return { nodes: out, uncutCount };
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
  const masked = await maskTraceroutesByChannel(traceroutes, user, source.id);
  // #5363: stored routePositions snapshots drawn at the corrected point.
  const signFlipCtx = await loadSignFlipContext(source.id);
  return masked.map(tr => applySignFlipToTraceroute(tr, signFlipCtx));
}

/**
 * Enriched neighbor-info for a source, channel-gated (mirrors GET /:id/neighbor-info).
 *
 * `maxNodeAgeHours` is PER-SOURCE as of #4412 Phase 2. The parameter exists
 * only so the unified fan-out can batch the lookup (one query for all sources)
 * instead of one per source; when omitted it is resolved for THIS source.
 */
export async function buildSourceNeighborInfo(
  source: SourceRow,
  user: ReqUser,
  maxNodeAgeHours?: number,
): Promise<unknown[]> {
  const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(source.id);

  const resolvedMaxAge = maxNodeAgeHours ?? await getMaxNodeAgeHours(databaseService.settings, source.id);
  // maxNodeAgeHours of 0 = "never / show all" (#4947, #5338): no cutoff.
  const cutoffTime = resolvedMaxAge <= 0
    ? -Infinity
    : Math.floor(Date.now() / 1000) - resolvedMaxAge * 60 * 60;

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

  // #5363: draw neighbor links to the same (corrected) point as the marker.
  const signFlipCtx = await loadSignFlipContext(source.id);

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
      const nodePos = getDisplayDbNodePosition(node, signFlipCtx);
      const neighborPos = getDisplayDbNodePosition(neighbor, signFlipCtx);

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
  /** Node rows before the age window cut; set only when it ran (applyDashboardAgeWindow). */
  nodeCount?: number;
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
  opts?: { maxNodeAgeHours?: number; nodePrefilter?: LiveNodeFilter },
): Promise<SourceDashboardPayload> {
  const isAdmin = user?.isAdmin === true;
  const canReadNodes = isAdmin || (user ? await hasPermission(user, 'nodes', 'read', source.id) : false);
  const canReadTraceroutes = isAdmin || (user ? await hasPermission(user, 'traceroute', 'read', source.id) : false);

  const [nodeResult, traceroutes, neighborInfo, channels] = await Promise.all([
    canReadNodes
      ? buildSourceNodesCounted(source, user, { slim: true, liveOnly: opts?.nodePrefilter })
      : Promise.resolve({ nodes: [] as unknown[], uncutCount: undefined }),
    canReadTraceroutes ? buildSourceTraceroutes(source, user) : Promise.resolve([]),
    canReadNodes ? buildSourceNeighborInfo(source, user, opts?.maxNodeAgeHours) : Promise.resolve([]),
    buildSourceChannels(source, user),
  ]);

  const payload: SourceDashboardPayload = {
    sourceId: source.id, nodes: nodeResult.nodes, traceroutes, neighborInfo, channels,
  };
  // Only a prefiltered read knows the uncut count; applyDashboardAgeWindow
  // fills it in from nodes.length otherwise.
  if (nodeResult.uncutCount !== undefined) payload.nodeCount = nodeResult.uncutCount;
  return payload;
}

/**
 * Node age windows the dashboard map filters on, in hours (<= 0 = no limit).
 * See resolveDashboardAgeWindow.
 */
export interface DashboardAgeWindow {
  nodeHours: number;
  infraHours: number;
}

/**
 * Extra seconds the server keeps past the window. The client compares
 * `lastHeard` against its own clock some time after this response was built,
 * so a node near the edge must reach it and let the client decide.
 */
export const DASHBOARD_AGE_GRACE_SEC = 3600;

/**
 * The widest window the Dashboard map can apply, across EVERY source.
 *
 * The map's cutoff is `useMaxNodeAgeHoursAcross` / `useMaxInfraNodeAgeHoursAcross`
 * over the sources it lists, each read from GET /api/settings?sourceId (the
 * per-source row, else the global row, else the default). This takes every
 * configured source and includes the default, so it is never narrower than
 * what the client computes, including while the client's settings queries are
 * still loading (it then uses the default). A 0 ("no limit") on any source
 * turns the cutoff off. The map slider can only narrow the window, never widen
 * it (MapAgeFilterControl), so the setting is the upper bound.
 */
export async function resolveDashboardAgeWindow(): Promise<DashboardAgeWindow> {
  const sources = await databaseService.sources.getAllSources();
  const ids = sources.map((s) => s.id);
  const settings = databaseService.settings;
  const [nodeGlobal, infraGlobal, nodeBySource, infraBySource] = await Promise.all([
    settings.getSetting('maxNodeAgeHours'),
    settings.getSetting('maxInfraNodeAgeHours'),
    settings.getSettingForSources(ids, 'maxNodeAgeHours'),
    settings.getSettingForSources(ids, 'maxInfraNodeAgeHours'),
  ]);
  const nodeValues: number[] = [NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours];
  const infraValues: number[] = [MAX_INFRA_NODE_AGE_HOURS_DEFAULT];
  for (const id of ids) {
    nodeValues.push(parseNodeDisplayNumber('maxNodeAgeHours', nodeBySource.get(id) ?? nodeGlobal));
    infraValues.push(parseMaxInfraNodeAgeHours(infraBySource.get(id) ?? infraGlobal));
  }
  const widest = (values: number[]) => (values.some((v) => v <= 0) ? 0 : Math.max(...values));
  return { nodeHours: widest(nodeValues), infraHours: widest(infraValues) };
}

/** nodeNums of every source's local node: the map's polar grid centres on them even when stale. */
export function localNodeNums(): Set<number> {
  const out = new Set<number>();
  for (const m of sourceManagerRegistry.getAllManagers()) {
    const num = Number(m.getLocalNodeInfo()?.nodeNum);
    if (Number.isFinite(num) && num > 0) out.add(num);
  }
  return out;
}

type AgeRow = {
  nodeNum?: unknown;
  isMeshCore?: unknown;
  advType?: unknown;
  lastHeard?: unknown;
  isFavorite?: unknown;
  aircraftAgedOutAt?: unknown;
};

/**
 * Whether one node row could pass the Dashboard map's age gate
 * (DashboardMap `passesAgeGate`). It errs towards keeping: the client still
 * applies its own gate, so a kept row costs bytes, a dropped one hides a node.
 */
function rowPassesAgeWindow(
  row: AgeRow,
  nodeCutoff: number,
  infraCutoff: number,
  keepNodeNums: Set<number>,
): boolean {
  if (row.isFavorite) return true;
  // Aged-out aircraft skip the age gate (isAgedOutAircraft); any row with the
  // mark is kept, ignored or not, as a superset.
  if (row.aircraftAgedOutAt != null) return true;
  if (!row.isMeshCore && keepNodeNums.has(Number(row.nodeNum))) return true;
  if (row.lastHeard == null) return false;
  const lastHeard = Number(row.lastHeard);
  if (!Number.isFinite(lastHeard)) return true;
  // MeshCore repeaters and room servers (advType 2/3) use the infra window
  // (isMeshCoreInfrastructureAdvType in components/MeshCore/meshcoreRole.ts).
  const isInfra = row.isMeshCore === true && (row.advType === 2 || row.advType === 3);
  return lastHeard >= (isInfra ? infraCutoff : nodeCutoff);
}

/**
 * Drop node rows the Dashboard map would hide by age.
 *
 * Works on the unified node key (`unifiedNodeKey`, the key the client merge
 * buckets on): if ANY row of a node passes, every row of that node is kept
 * across all `bundles`. The merged node takes `lastHeard` as the max over
 * rows, `isFavorite` as an OR, and its position from whichever row has one, so
 * dropping an old row of a live node could move or hide its marker.
 *
 * Sets `nodeCount` on each bundle to its row count before the cut, so the
 * sidebar's per-source node total does not shrink; a bundle built with
 * `nodePrefilter` already carries it. Mutates `bundles`.
 */
export function applyDashboardAgeWindow(
  bundles: SourceDashboardPayload[],
  window: DashboardAgeWindow,
  keepNodeNums: Set<number>,
  nowSec: number = Date.now() / 1000,
): void {
  // "No limit" on both windows: nothing to cut.
  if (window.nodeHours <= 0 && window.infraHours <= 0) {
    for (const b of bundles) b.nodeCount ??= b.nodes.length;
    return;
  }
  const nodeCutoff = window.nodeHours <= 0 ? -Infinity : nowSec - window.nodeHours * 3600 - DASHBOARD_AGE_GRACE_SEC;
  const infraCutoff = window.infraHours <= 0 ? -Infinity : nowSec - window.infraHours * 3600 - DASHBOARD_AGE_GRACE_SEC;

  const liveKeys = new Set<string>();
  for (const b of bundles) {
    for (const row of b.nodes as AgeRow[]) {
      const key = unifiedNodeKey(row as Parameters<typeof unifiedNodeKey>[0]);
      if (key !== null && !liveKeys.has(key) && rowPassesAgeWindow(row, nodeCutoff, infraCutoff, keepNodeNums)) {
        liveKeys.add(key);
      }
    }
  }
  for (const b of bundles) {
    b.nodeCount ??= b.nodes.length;
    b.nodes = b.nodes.filter((row) => {
      const key = unifiedNodeKey(row as Parameters<typeof unifiedNodeKey>[0]);
      // No identity: the unified merge drops it; a single-source view still
      // draws it, so keep it.
      return key === null || liveKeys.has(key);
    });
  }
}

/**
 * Above this many live nodes, buildSourceDashboard reads by subquery instead
 * of a bound list, well under every backend's bind-parameter limit.
 */
export const DASHBOARD_LIVE_NODE_LIST_MAX = 5000;

/**
 * The SQL side of applyDashboardAgeWindow, for buildSourceDashboard's
 * `nodePrefilter`: read only the Meshtastic rows of nodes that have a row
 * in `sourceIds` the cut could keep, instead of every row.
 *
 * It must select a SUPERSET of what applyDashboardAgeWindow keeps (that pass
 * still runs on the result and makes the output exact):
 * - keyed on nodeNum, which is the unified key of every Meshtastic DB row
 *   (`mt:<nodeNum>`), and taken over all `sourceIds` regardless of what the
 *   caller may see there;
 * - the cutoff is floored and taken now, before the in-memory pass takes its
 *   own (later, so larger) cutoff;
 * - Meshtastic rows are never MeshCore infra, so only the node window
 *   applies. MeshCore rows are not read from this table and are left alone.
 *
 * Undefined when the node window is off (every Meshtastic row passes). The
 * live nodeNums are looked up once here, so the per-source reads bind them
 * as a list (up to DASHBOARD_LIVE_NODE_LIST_MAX; past that each read runs
 * the subquery itself).
 */
export async function dashboardNodePrefilter(
  sourceIds: string[],
  window: DashboardAgeWindow,
  keepNodeNums: Set<number>,
  nowSec: number = Date.now() / 1000,
): Promise<LiveNodeFilter | undefined> {
  if (window.nodeHours <= 0 || sourceIds.length === 0) return undefined;
  const filter: LiveNodeFilter = {
    sourceIds,
    minLastHeard: Math.floor(nowSec - window.nodeHours * 3600 - DASHBOARD_AGE_GRACE_SEC),
    keepNodeNums: [...keepNodeNums],
  };
  const nodeNums = await databaseService.nodes.getLiveNodeNums(filter);
  if (nodeNums.length <= DASHBOARD_LIVE_NODE_LIST_MAX) filter.nodeNums = nodeNums;
  return filter;
}
