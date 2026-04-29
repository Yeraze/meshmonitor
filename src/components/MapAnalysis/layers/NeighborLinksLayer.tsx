import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

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

interface NodeRecord {
  nodeNum: number;
  sourceId?: string;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

/**
 * Renders a dashed line for each neighbor edge between two positioned nodes
 * sharing the same source. Edge opacity is derived from SNR.
 */
export default function NeighborLinksLayer() {
  const { config } = useMapAnalysisCtx();
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
      const lat = n.position?.latitude;
      const lon = n.position?.longitude;
      if (lat != null && lon != null) {
        map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, [lat, lon]);
      }
    }
    return map;
  }, [nodes]);

  const edges = useMemo(() => {
    const out: Array<{ key: string; positions: [number, number][]; opacity: number }> = [];
    const items = (data as { items?: NeighborEdge[] } | undefined)?.items ?? [];
    for (const e of items) {
      const a = positionByKey.get(`${e.sourceId}:${Number(e.nodeNum)}`);
      const b = positionByKey.get(`${e.sourceId}:${Number(e.neighborNum)}`);
      if (!a || !b) continue;
      out.push({ key: String(e.id), positions: [a, b], opacity: snrToOpacity(e.snr) });
    }
    return out;
  }, [data, positionByKey]);

  return (
    <>
      {edges.map((e) => (
        <Polyline
          key={e.key}
          positions={e.positions}
          pathOptions={{ color: '#06b6d4', weight: 1, opacity: e.opacity, dashArray: '4 4' }}
        />
      ))}
    </>
  );
}
