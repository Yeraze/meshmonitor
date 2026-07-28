import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Publishes the 2D map's live camera into the shared `mapViewRef` (#4371 A).
 *
 * Renders nothing. Both map branches apply `center`/`zoom` at mount only
 * (BaseMap/Base3DMap convention), so switching 2D↔3D used to snap the new
 * surface back to the Default Map Center — or, with no default configured, to
 * the `[30, -90]` fallback. Recording the view here (and, in 3D, via
 * `Base3DMap`'s `onViewChange`) gives the incoming branch something current to
 * mount at.
 *
 * A ref, not state, so a pan doesn't re-render every layer — see the
 * `mapViewRef` doc comment in `MapAnalysisContext`.
 */
export default function MapViewStateController() {
  const map = useMap();
  const { mapViewRef } = useMapAnalysisCtx();

  useEffect(() => {
    if (!map) return;
    const publish = () => {
      const c = map.getCenter();
      // Leaflet has no pitch/bearing; preserve whatever a previous 3D session
      // recorded so a 3D→2D→3D round-trip keeps the camera angle.
      const prev = mapViewRef.current;
      mapViewRef.current = {
        center: [c.lat, c.lng],
        zoom: map.getZoom(),
        pitch: prev?.pitch,
        bearing: prev?.bearing,
      };
    };
    publish(); // seed immediately so a switch before any pan still carries over
    map.on('moveend', publish);
    return () => {
      map.off('moveend', publish);
    };
  }, [map, mapViewRef]);

  return null;
}
