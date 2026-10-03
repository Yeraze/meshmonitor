import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { WORLD_BOUNDS } from './worldBounds';

/**
 * Keeps a single-world map from zooming out past the point where the world
 * fills the viewport (#5556).
 *
 * `BaseMap` locks the view inside `WORLD_BOUNDS` and stops raster tiles from
 * wrapping. Without a floor, zooming further out shrinks that one world below
 * the container and leaves grey bars beside it. A fixed `minZoom: 2` is not
 * enough: at zoom 2 the world is 1024 px wide, so any wider window still gets
 * bars. Instead we ask Leaflet for the smallest zoom at which the world
 * covers the whole container (`getBoundsZoom(bounds, inside = true)`), and
 * recompute it on every container resize (window resize, rotation, sidebar
 * collapse — `MapResizeHandler` fires `resize` through `invalidateSize`).
 * Small maps (dashboard widgets, embeds) keep low floors; only maps wider or
 * taller than the world get a higher one.
 *
 * Mount it before any child that fits the view, so a `fitBounds` already sees
 * the floor (sibling effects run in order).
 */
export function WorldFillMinZoom() {
  const map = useMap();

  useEffect(() => {
    // Partial map mocks in unit tests lack these methods.
    if (
      typeof map?.getBoundsZoom !== 'function' ||
      typeof map.setMinZoom !== 'function' ||
      typeof map.getSize !== 'function' ||
      typeof map.on !== 'function'
    ) {
      return;
    }

    const apply = () => {
      const size = map.getSize();
      // A hidden container (inactive tab, collapsed panel) measures 0×0;
      // getBoundsZoom would return -Infinity/NaN. Keep the last floor.
      if (!(size.x > 0 && size.y > 0)) return;
      const fill = map.getBoundsZoom(WORLD_BOUNDS, true);
      if (!Number.isFinite(fill)) return;
      const floor = Math.max(0, fill);
      if (map.getZoom() < floor) {
        // Jump, don't animate: on mount this would otherwise play a zoom-in
        // animation every time a map opens zoomed out.
        map.setView(map.getCenter(), floor, { animate: false });
      }
      map.setMinZoom(floor);
    };

    apply();
    map.on('resize', apply);
    return () => {
      map.off('resize', apply);
    };
  }, [map]);

  return null;
}
