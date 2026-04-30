import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';

function snrToOpacity(snr: number | null): number {
  if (snr === null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
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
 * Renders a dashed line for each neighbor edge between two positioned nodes
 * sharing the same source. Edge opacity is derived from SNR.
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
      nodeNum: number;
      neighborNum: number;
      snr: number | null;
      timestamp?: number;
    }> = [];
    const items = (data as { items?: NeighborEdge[] } | undefined)?.items ?? [];
    const filtered = items.filter((e) => inWindow(e.timestamp ?? 0));
    for (const e of filtered) {
      const a = positionByKey.get(`${e.sourceId}:${Number(e.nodeNum)}`);
      const b = positionByKey.get(`${e.sourceId}:${Number(e.neighborNum)}`);
      if (!a || !b) continue;
      out.push({
        key: String(e.id),
        positions: [a, b],
        opacity: snrToOpacity(e.snr),
        sourceId: e.sourceId,
        nodeNum: Number(e.nodeNum),
        neighborNum: Number(e.neighborNum),
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
          pathOptions={{ color: '#06b6d4', weight: 1, opacity: e.opacity, dashArray: '4 4' }}
          eventHandlers={{
            click: () =>
              setSelected({
                type: 'neighbor',
                sourceId: e.sourceId,
                nodeNum: e.nodeNum,
                neighborNum: e.neighborNum,
                snr: e.snr,
                timestamp: e.timestamp,
              }),
          }}
        />
      ))}
    </>
  );
}
