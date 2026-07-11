import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { classifyNodeTransport, type NodeTransportClass } from '../../../utils/nodeTransport';
import { snrToNeighborOpacity } from '../../../utils/neighborLinks';
import {
  NeighborLinksLayer as SharedNeighborLinksLayer,
  type NeighborLinkDescriptor,
} from '../../map/layers/NeighborLinksLayer';

function transportColor(tc: NodeTransportClass): string {
  if (tc === 'mqtt') return '#22c55e';
  if (tc === 'udp') return '#f97316';
  return '#06b6d4';
}

interface NeighborEdge {
  id: number | string;
  nodeNum: number;
  neighborNum: number;
  sourceId: string;
  snr: number | null;
  timestamp?: number;
}

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
}

/**
 * Renders a dashed line for each neighbor edge between two positioned nodes.
 * Endpoint positions prefer the edge's own source but fall back to any selected
 * source that has the node positioned, so cross-source links render (#3792).
 * Edge opacity is derived from SNR.
 *
 * Thin adapter (Map Consolidation epic #4047, Phase 7, WP6): owns all
 * MapAnalysis-specific data wiring (neighbor-edge fetch, endpoint position/
 * transport resolution incl. the #3792 cross-source fallback, time-window
 * filter) and maps its output onto the shared descriptor-based
 * `src/components/map/layers/NeighborLinksLayer` for rendering. `pathOptions`
 * (transport-colored, weight 1, dash `'4 4'`) and the click→`setSelected`
 * handler are unchanged from before the promotion — this is a pure refactor
 * of render mechanics, not a visual-convergence pass (deferred, see
 * MAP_CONSOLIDATION_P7_SPEC.md §6.1).
 */
export default function NeighborLinksLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.neighbors;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { data } = useNeighbors({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, ll);
    }
    return map;
  }, [nodes]);

  const transportByKey = useMemo(() => {
    const map = new Map<string, NodeTransportClass>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, classifyNodeTransport(n as any));
    }
    return map;
  }, [nodes]);

  // Cross-source fallback maps keyed by nodeNum alone (#3792). A neighbor edge
  // carries the sourceId of the *reporting* node, but the *other* endpoint's
  // position may only be recorded under a different selected source. Looking up
  // both endpoints strictly by the edge's sourceId would miss those and
  // silently drop the edge, turning the intended union of links into an
  // intersection. We prefer the source-scoped position but fall back to any
  // selected source that has a position for that nodeNum.
  const positionByNode = useMemo(() => {
    const map = new Map<number, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      const ll = resolveNodeLatLng(n);
      if (ll && !map.has(Number(n.nodeNum))) map.set(Number(n.nodeNum), ll);
    }
    return map;
  }, [nodes]);

  const transportByNode = useMemo(() => {
    const map = new Map<number, NodeTransportClass>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      if (!map.has(Number(n.nodeNum))) map.set(Number(n.nodeNum), classifyNodeTransport(n as any));
    }
    return map;
  }, [nodes]);

  const ts = config.timeSlider;
  const inWindow = (t: number): boolean =>
    !ts.enabled ||
    ts.windowStartMs === undefined ||
    ts.windowEndMs === undefined ||
    (t >= ts.windowStartMs && t <= ts.windowEndMs);

  const edges = useMemo(() => {
    const out: Array<{
      key: string;
      positions: [[number, number], [number, number]];
      opacity: number;
      sourceId: string;
      nodeNum: number;
      neighborNum: number;
      snr: number | null;
      timestamp?: number;
      transportClass: NodeTransportClass;
    }> = [];
    const items = (data as { items?: NeighborEdge[] } | undefined)?.items ?? [];
    const filtered = items.filter((e) => inWindow(e.timestamp ?? 0));
    for (const e of filtered) {
      const aKey = `${e.sourceId}:${Number(e.nodeNum)}`;
      const bKey = `${e.sourceId}:${Number(e.neighborNum)}`;
      // Source-scoped position preferred; fall back to the node's position on
      // any other selected source so cross-source edges aren't dropped (#3792).
      const a = positionByKey.get(aKey) ?? positionByNode.get(Number(e.nodeNum));
      const b = positionByKey.get(bKey) ?? positionByNode.get(Number(e.neighborNum));
      if (!a || !b) continue;
      const aTx = transportByKey.get(aKey) ?? transportByNode.get(Number(e.nodeNum)) ?? 'rf';
      const bTx = transportByKey.get(bKey) ?? transportByNode.get(Number(e.neighborNum)) ?? 'rf';
      const tc: NodeTransportClass = aTx === 'mqtt' || bTx === 'mqtt' ? 'mqtt' : aTx === 'udp' || bTx === 'udp' ? 'udp' : 'rf';
      out.push({
        key: String(e.id),
        positions: [a, b],
        opacity: snrToNeighborOpacity(e.snr),
        sourceId: e.sourceId,
        nodeNum: Number(e.nodeNum),
        neighborNum: Number(e.neighborNum),
        snr: e.snr,
        timestamp: e.timestamp,
        transportClass: tc,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, positionByKey, positionByNode, transportByKey, transportByNode, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  const links = useMemo<NeighborLinkDescriptor[]>(
    () =>
      edges.map((e) => ({
        key: e.key,
        positions: e.positions,
        pathOptions: { color: transportColor(e.transportClass), weight: 1, opacity: e.opacity, dashArray: '4 4' },
        eventHandlers: {
          click: () =>
            setSelected({
              type: 'neighbor',
              sourceId: e.sourceId,
              nodeNum: e.nodeNum,
              neighborNum: e.neighborNum,
              snr: e.snr,
              timestamp: e.timestamp,
            }),
        },
      })),
    [edges, setSelected],
  );

  return <SharedNeighborLinksLayer links={links} />;
}
