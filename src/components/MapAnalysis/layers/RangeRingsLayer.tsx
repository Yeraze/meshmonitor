import { Circle } from 'react-leaflet';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
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

  const filtered = ((nodes ?? []) as NodeRecord[])
    .map((n) => ({ node: n, latLng: resolveNodeLatLng(n) }))
    .filter(({ node, latLng }) => {
      if (!latLng) return false;
      if (config.sources.length === 0) return true;
      if (!node.sourceId) return false;
      return config.sources.includes(node.sourceId);
    });

  return (
    <>
      {filtered.map(({ node: n, latLng }) => (
        <Circle
          key={`${n.sourceId ?? ''}:${n.nodeNum}`}
          center={latLng!}
          radius={radiusKm * 1000}
          pathOptions={{ color: '#a855f7', fillOpacity: 0.05, weight: 1 }}
        />
      ))}
    </>
  );
}
