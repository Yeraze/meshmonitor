import { Circle } from 'react-leaflet';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

interface NodeRecord {
  nodeNum: number;
  sourceId?: string;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

/**
 * Renders a translucent circle around each positioned node at a configurable
 * radius (in km, stored under `config.layers.rangeRings.options.radiusKm`).
 * Filters by `config.sources` like other layers.
 */
export default function RangeRingsLayer() {
  const { config } = useMapAnalysisCtx();
  const radiusKm = (config.layers.rangeRings.options?.radiusKm as number) ?? 5;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  const filtered = ((nodes ?? []) as NodeRecord[]).filter((n) => {
    const lat = n.position?.latitude;
    const lon = n.position?.longitude;
    if (lat == null || lon == null) return false;
    if (config.sources.length === 0) return true;
    if (!n.sourceId) return false;
    return config.sources.includes(n.sourceId);
  });

  return (
    <>
      {filtered.map((n) => (
        <Circle
          key={`${n.sourceId ?? ''}:${n.nodeNum}`}
          center={[n.position!.latitude as number, n.position!.longitude as number]}
          radius={radiusKm * 1000}
          pathOptions={{ color: '#a855f7', fillOpacity: 0.05, weight: 1 }}
        />
      ))}
    </>
  );
}
