import { CircleMarker } from 'react-leaflet';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

interface PositionRecord {
  nodeNum: number;
  sourceId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * v1 limitation: position rows from /api/analysis/positions don't carry SNR
 * (positions are pivoted from telemetry, which doesn't store per-fix SNR).
 * The layer renders dots at each fix in gray as a coverage overlay. Per-fix
 * SNR coloring is deferred to a future task that joins from packet_log.
 */
export default function SnrOverlayLayer() {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.snrOverlay;
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

  return (
    <>
      {(items as PositionRecord[]).map((p, i) => (
        <CircleMarker
          key={`${p.sourceId}:${p.nodeNum}:${p.timestamp}:${i}`}
          center={[p.latitude, p.longitude]}
          radius={4}
          pathOptions={{ color: '#888', fillOpacity: 0.7, weight: 1 }}
        />
      ))}
    </>
  );
}
