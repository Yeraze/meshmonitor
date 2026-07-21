import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';
import { nodeMatchesSearch } from './nodeSearch';
import { getNodeTypeCategory } from '../../utils/nodeTypeCategory';
import { nodePassesTransportFilter, transportCutoffSec } from '../../utils/nodeTransport';
import { getActiveWindowHours } from '../../utils/activeWindowConfig';
import { unifiedNodeKey } from '../../utils/nodeIdentity';
import { applyPrecisionCellOffsets } from '../../utils/precisionOffset';
import type { NodeSourceRef } from '../Dashboard/DashboardNodePopup';

/**
 * Node shape consumed across the Map Analysis surface (markers, picker,
 * inspector). Originally declared inline in `NodeMarkersLayer`; moved here
 * (issue #3788 WP-B) so `useAnalysisNodes` and its consumers share one
 * definition instead of drifting copies.
 */
export interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  nodeId?: string | null;
  longName?: string | null;
  shortName?: string | null;
  hideFromMap?: boolean | null;
  user?: { role?: string | number | null } | null;
  isMeshCore?: boolean;
  advType?: number | null;
  /** Unix seconds of last reception; drives time-slider opacity fade (#3886). */
  lastHeard?: number | null;
  /** Every configured source that reported this node (unified merge, #2805). */
  sources?: NodeSourceRef[];
  /** MeshCore public key; needed by `unifiedNodeKey` for cross-source selection identity (#3788). */
  publicKey?: string | null;
  /** Meshtastic obscured-position precision (0–32 bits); drives the #4016 within-cell offset. */
  positionPrecisionBits?: number | null;
  /** True when the position is a user override — excluded from the #4016 offset. */
  positionIsOverride?: boolean | null;
  /** Most-recent transport mechanism; drives the #4129 Show RF/UDP/MQTT filter. */
  transportMechanism?: number | null;
  /** Legacy MQTT flag honored when `transportMechanism` is missing (#4129). */
  viaMqtt?: boolean | null;
  /** Union of transport classes across sources (unified merge); makes the #4129 filter additive. */
  transportClasses?: Array<'rf' | 'udp' | 'mqtt'> | null;
}

export interface AnalysisNode {
  node: NodeRecord;
  latLng: [number, number];
  key: string;
}

/**
 * Shared positioned+visible node list for the Map Analysis surface (issue
 * #3788 WP-B). Applies the SAME predicate `NodeMarkersLayer` used to apply
 * inline: hideFromMap, node search, node-type category, and the
 * `config.sources` allow-list — so the node picker and the map markers layer
 * can never disagree about which nodes exist/are visible.
 *
 * Only positioned nodes are returned (a node can't be "followed"/emphasized
 * on the map if it has no coordinates to plot), and nodes whose
 * `unifiedNodeKey` is null (no stable cross-source identity) are dropped.
 */
export function useAnalysisNodes(): AnalysisNode[] {
  const { config, nodeFilter } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as Array<{ id: string; name: string }>;
  const sourceIds = sourceList.map((s) => s.id);
  // Pass the FULL source objects (not bare ids) so the unified merge stamps the
  // per-node `sources` array used by the multi-source filter below and by the
  // popup's "Seen by N sources" list.
  const { nodes } = useDashboardUnifiedData(sources, sourceIds.length > 0);
  // #4240: transport classification decays against the user's active window,
  // same as every other map surface. Read from the non-context mirror rather
  // than SettingsContext — this is a data hook feeding several Map Analysis
  // components, and depending on a UI provider here would force every consumer
  // (and every consumer's tests) to wrap SettingsProvider.
  const transportCutoff = transportCutoffSec(getActiveWindowHours());

  return useMemo(() => {
    const visible = ((nodes ?? []) as NodeRecord[])
      .map((n) => ({ node: n, latLng: resolveNodeLatLng(n) }))
      .filter(
        (
          entry,
        ): entry is { node: NodeRecord; latLng: [number, number] } => {
          const { node, latLng } = entry;
          if (!latLng) return false;
          // #3549: per-node "Hide from Map" suppresses the marker on every map surface.
          if (node.hideFromMap) return false;
          // Node search (issue #3399): hide non-matches.
          if (!nodeMatchesSearch(node, nodeFilter)) return false;
          // Node-type filter (issue #3546): hide categories the user toggled off.
          if (config.nodeTypes[getNodeTypeCategory(node)] === false) return false;
          // Transport filter (issue #4129): Show RF / UDP / MQTT. Additive across
          // sources via the same per-node classifier the Dashboard/NodesTab maps
          // use, so an mqtt_bridge-relayed node is covered as MQTT.
          if (
            !nodePassesTransportFilter(node, {
              showRfNodes: config.transports.rf,
              showUdpNodes: config.transports.udp,
              showMqttNodes: config.transports.mqtt,
            }, transportCutoff)
          ) {
            return false;
          }
          if (config.sources.length === 0) return true;
          // Source filter: a unified-merged node can be reported by several sources
          // (node.sources). It must stay visible if ANY of those is enabled — not
          // just its primary sourceId — so multi-source nodes don't vanish when only
          // one of their sources is selected. Fall back to sourceId for unmerged rows.
          const nodeSourceIds = node.sources && node.sources.length > 0
            ? node.sources.map((s) => s.sourceId)
            : (node.sourceId ? [node.sourceId] : []);
          return nodeSourceIds.some((id) => config.sources.includes(id));
        },
      );

    // #4016/#4155 obscured-GPS marker offset, via the shared occupancy-gated
    // helper so every map surface declutters identically (lone nodes stay
    // centered; 2+ same-cell nodes spread). Applied here — the single latLng
    // source — so markers, Follow, bounds, the measurement tool, and the popup
    // all use the same position.
    return applyPrecisionCellOffsets(
      visible.map(({ node, latLng }) => ({
        item: node,
        id: unifiedNodeKey(node) ?? String(node.nodeNum),
        latLng,
        bits: node.positionPrecisionBits,
        isOverride: node.positionIsOverride,
      })),
    )
      .map(({ item: node, latLng }) => ({ node, latLng, key: unifiedNodeKey(node) }))
      .filter((entry): entry is AnalysisNode => entry.key !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4240 transportCutoff is a fresh clock read each render; listing it would recompute this memo every render. `nodes` changes on the 15s poll, which re-runs this with a current cutoff.
  }, [nodes, nodeFilter, config.nodeTypes, config.transports, config.sources]);
}
