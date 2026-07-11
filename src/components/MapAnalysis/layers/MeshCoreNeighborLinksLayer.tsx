import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useMeshCoreNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { snrToNeighborOpacity } from '../../../utils/neighborLinks';
import {
  NeighborLinksLayer as SharedNeighborLinksLayer,
  type NeighborLinkDescriptor,
} from '../../map/layers/NeighborLinksLayer';

const MC_NEIGHBOR_COLOR = '#06b6d4';

interface MeshCoreNeighborEdge {
  id: number;
  publicKey: string;
  neighborPublicKey: string;
  sourceId: string;
  snr: number | null;
  timestamp: number;
  nodeName: string | null;
  neighborName: string | null;
}

interface MCNodeRecord extends MaybePositionedNode {
  sourceId?: string;
  isMeshCore?: boolean;
  publicKey?: string;
}

/**
 * MeshCore analogue of `NeighborLinksLayer` — fixed cyan look (no
 * transport-class coloring; MeshCore edges have no RF/UDP/MQTT concept).
 *
 * Thin adapter (Map Consolidation epic #4047, Phase 7, WP6): owns all
 * MapAnalysis-specific data wiring (MeshCore neighbor-edge fetch, endpoint
 * position resolution keyed by `publicKey`, time-window filter) and maps its
 * output onto the shared descriptor-based
 * `src/components/map/layers/NeighborLinksLayer` for rendering.
 * `pathOptions` (fixed cyan, weight 1.5, dash `'6 4'`) and the
 * click→`setSelected` handler are unchanged from before the promotion — pure
 * refactor of render mechanics only.
 */
export default function MeshCoreNeighborLinksLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.neighbors;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { data } = useMeshCoreNeighbors({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as MCNodeRecord[]) {
      if (!n.isMeshCore || !n.publicKey) continue;
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${n.publicKey}`, ll);
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
      publicKey: string;
      neighborPublicKey: string;
      nodeName: string | null;
      neighborName: string | null;
      snr: number | null;
      timestamp: number;
    }> = [];
    const items = (data as { items?: MeshCoreNeighborEdge[] } | undefined)?.items ?? [];
    const filtered = items.filter((e) => inWindow(e.timestamp));
    for (const e of filtered) {
      const aKey = `${e.sourceId}:${e.publicKey}`;
      const bKey = `${e.sourceId}:${e.neighborPublicKey}`;
      const a = positionByKey.get(aKey);
      const b = positionByKey.get(bKey);
      if (!a || !b) continue;
      out.push({
        key: String(e.id),
        positions: [a, b],
        opacity: snrToNeighborOpacity(e.snr),
        sourceId: e.sourceId,
        publicKey: e.publicKey,
        neighborPublicKey: e.neighborPublicKey,
        nodeName: e.nodeName,
        neighborName: e.neighborName,
        snr: e.snr,
        timestamp: e.timestamp,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, positionByKey, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  const links = useMemo<NeighborLinkDescriptor[]>(
    () =>
      edges.map((e) => ({
        key: e.key,
        positions: e.positions,
        pathOptions: { color: MC_NEIGHBOR_COLOR, weight: 1.5, opacity: e.opacity, dashArray: '6 4' },
        eventHandlers: {
          click: () =>
            setSelected({
              type: 'neighbor',
              sourceId: e.sourceId,
              publicKey: e.publicKey,
              neighborPublicKey: e.neighborPublicKey,
              nodeName: e.nodeName,
              neighborName: e.neighborName,
              snr: e.snr,
              timestamp: e.timestamp,
              nodeNum: 0,
              neighborNum: 0,
            }),
        },
      })),
    [edges, setSelected],
  );

  return <SharedNeighborLinksLayer links={links} />;
}
