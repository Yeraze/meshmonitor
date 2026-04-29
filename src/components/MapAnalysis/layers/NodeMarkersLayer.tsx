import { Marker, Popup } from 'react-leaflet';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

interface NodeRecord {
  nodeNum: number;
  sourceId?: string;
  longName?: string | null;
  shortName?: string | null;
  position?: { latitude?: number | null; longitude?: number | null } | null;
}

/**
 * Renders one Marker per node that has a position. When `config.sources` is
 * non-empty, only nodes whose sourceId is in the allow-list are shown; an
 * empty list means "all sources" (Unified semantics).
 *
 * Clicking a marker writes the selection into MapAnalysisContext so the
 * inspector panel can react.
 */
export default function NodeMarkersLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceIds = (sources as { id: string }[]).map((s) => s.id);
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  const filteredNodes = ((nodes ?? []) as NodeRecord[]).filter((n) => {
    const lat = n.position?.latitude;
    const lon = n.position?.longitude;
    if (lat == null || lon == null) return false;
    if (config.sources.length === 0) return true;
    if (!n.sourceId) return false;
    return config.sources.includes(n.sourceId);
  });

  return (
    <>
      {filteredNodes.map((n) => {
        const lat = n.position!.latitude as number;
        const lon = n.position!.longitude as number;
        const sourceId = n.sourceId ?? '';
        return (
          <Marker
            key={`${sourceId}:${n.nodeNum}`}
            position={[lat, lon]}
            eventHandlers={{
              click: () =>
                setSelected({
                  type: 'node',
                  nodeNum: Number(n.nodeNum),
                  sourceId,
                }),
            }}
          >
            <Popup>
              <strong>
                {n.longName ?? n.shortName ?? `!${Number(n.nodeNum).toString(16)}`}
              </strong>
              <div>Source: {sourceId || '(unknown)'}</div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
