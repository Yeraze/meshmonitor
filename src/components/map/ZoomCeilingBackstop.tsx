import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

/**
 * Guarantees the map a finite zoom ceiling (#5516).
 *
 * Leaflet takes its `maxZoom` from the zoom-bounded layers on the map. If none
 * of them registers one, `getMaxZoom()` is Infinity and leaflet.markercluster
 * throws "Map has no maxZoom specified" when it mounts. `VectorTileLayer` now
 * registers its own bound; this is the backstop for any layer that does not.
 *
 * It only acts when the ceiling is missing, so it never overrides a real one.
 * A `maxZoom` prop on `MapContainer` would not work here: it is read once at
 * mount, and as a map option it beats every layer bound, so switching to a
 * tileset with a lower ceiling would keep the stale one.
 *
 * Mount it after the base tile layer and before any clustering children:
 * sibling effects run in order, so it sees the base layer's bound and runs
 * before the cluster group reads `getMaxZoom()`.
 */
export function ZoomCeilingBackstop({ maxZoom }: { maxZoom: number }) {
  const map = useMap();

  useEffect(() => {
    // Partial map mocks in unit tests lack these methods.
    if (typeof map?.getMaxZoom !== 'function' || typeof map.setMaxZoom !== 'function') return;
    if (Number.isFinite(map.getMaxZoom())) return;
    map.setMaxZoom(maxZoom);
    return () => {
      // Hand control back to the layer bounds (Leaflet treats an undefined
      // map option as "use the layers"), so the next tileset's own ceiling
      // wins once it is mounted.
      map.setMaxZoom(undefined as unknown as number);
    };
  }, [map, maxZoom]);

  return null;
}
