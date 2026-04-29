import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 55%)`;
}

interface PositionRecord {
  nodeNum: number;
  sourceId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * Renders a polyline per node connecting that node's recent position fixes
 * (sorted by timestamp). Color is deterministic per (sourceId, nodeNum) key.
 * Nodes with fewer than 2 fixes are skipped.
 */
export default function PositionTrailsLayer() {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.trails;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { items } = usePositions({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  const trails = useMemo(() => {
    const grouped = new Map<string, Array<{ ts: number; pos: [number, number] }>>();
    for (const p of items as PositionRecord[]) {
      const key = `${p.sourceId}:${Number(p.nodeNum)}`;
      const arr = grouped.get(key) ?? [];
      arr.push({ ts: p.timestamp, pos: [p.latitude, p.longitude] });
      grouped.set(key, arr);
    }
    const out: Array<{ key: string; positions: [number, number][]; color: string }> = [];
    for (const [key, arr] of grouped) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.ts - b.ts);
      out.push({ key, positions: arr.map((x) => x.pos), color: colorForKey(key) });
    }
    return out;
  }, [items]);

  return (
    <>
      {trails.map((t) => (
        <Polyline
          key={t.key}
          positions={t.positions}
          pathOptions={{ color: t.color, weight: 2, opacity: 0.7 }}
        />
      ))}
    </>
  );
}
