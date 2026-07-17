import { CircleMarker } from 'react-leaflet';
import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Ephemeral marker showing where the Link Profile elevation-graph cursor maps to
 * on the terrain (#4111 follow-up). `hoverPoint` is set by {@link LinkProfileDrawer}
 * on chart mousemove (from the hovered sample's lat/lng) and cleared on
 * mouseleave / reset, so this renders only while the user is scrubbing the graph.
 *
 * Non-interactive so it never intercepts map clicks (e.g. endpoint picking), and
 * mounted unconditionally by the Canvas — it simply renders nothing when there is
 * no hover point, which keeps it working whether or not pick-mode is still active.
 */
export default function LinkProfileHoverLayer() {
  const { hoverPoint } = useMapAnalysisCtx();
  if (!hoverPoint) return null;
  return (
    <CircleMarker
      center={[hoverPoint.lat, hoverPoint.lng]}
      radius={7}
      interactive={false}
      pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }}
    />
  );
}
