import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useMeshCoreNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';

function snrToOpacity(snr: number | null): number {
  if (snr === null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
}

const MC_NEIGHBOR_COLOR = '#06b6d4';

interface MeshCoreNeighborEdge {
  id: number;
  publicKey: string;
  neighborPublicKey: string;
  sourceId: string;
  snr: number | null;
  timestamp: number;
}

interface MCNodeRecord extends MaybePositionedNode {
  sourceId?: string;
  isMeshCore?: boolean;
  publicKey?: string;
}

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
      positions: [number, number][];
      opacity: number;
      sourceId: string;
      publicKey: string;
      neighborPublicKey: string;
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
        opacity: snrToOpacity(e.snr),
        sourceId: e.sourceId,
        publicKey: e.publicKey,
        neighborPublicKey: e.neighborPublicKey,
        snr: e.snr,
        timestamp: e.timestamp,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, positionByKey, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  return (
    <>
      {edges.map((e) => (
        <Polyline
          key={e.key}
          positions={e.positions}
          pathOptions={{ color: MC_NEIGHBOR_COLOR, weight: 1.5, opacity: e.opacity, dashArray: '6 4' }}
          eventHandlers={{
            click: () =>
              setSelected({
                type: 'neighbor',
                sourceId: e.sourceId,
                publicKey: e.publicKey,
                neighborPublicKey: e.neighborPublicKey,
                snr: e.snr,
                timestamp: e.timestamp,
                nodeNum: 0,
                neighborNum: 0,
              }),
          }}
        />
      ))}
    </>
  );
}
