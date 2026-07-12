import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import {
  DEFAULT_TARGET_ZOOM,
  computeClampedTargetZoom,
  computeZoomAnimationDuration,
} from '../utils/mapZoomAnimation';

interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
  /**
   * User-configurable target zoom (issue #4046 item 2, `mapCenterTargetZoom`
   * setting). The actual zoom used is `Math.max(map.getZoom(), targetZoom)`
   * — this only ever zooms IN, never forces a zoom-out when the user is
   * already closer than `targetZoom`. Defaults to DEFAULT_TARGET_ZOOM (17).
   */
  targetZoom?: number;
}

/**
 * MapCenterController is a Leaflet map controller component that centers the map
 * on a specific target location and adjusts the view to ensure popup visibility.
 *
 * This component doesn't render any visible elements (returns null) but uses
 * Leaflet's map API to programmatically control the map view.
 */
export const MapCenterController: React.FC<MapCenterControllerProps> = ({
  centerTarget,
  onCenterComplete,
  targetZoom = DEFAULT_TARGET_ZOOM,
}) => {
  const map = useMap();

  useEffect(() => {
    if (centerTarget) {
      // Get the map container height to calculate the center offset
      const mapContainer = map.getContainer();
      const mapHeight = mapContainer.clientHeight;

      // We want the popup (which appears above the marker) centered in viewport
      // To do this, the marker needs to be below center
      // In Leaflet's pixel coordinate system, Y increases downward
      // So to move the target point UP in screen space, we SUBTRACT from Y
      const panOffset = Math.floor(mapHeight / 4);

      const currentZoom = map.getZoom();
      // #4046 item 2: clamp so we only ever zoom IN — never force a
      // disorienting zoom-out when the user is already closer than
      // targetZoom. When the clamp results in no zoom change, Leaflet's
      // `_tryAnimatedPan` path runs (pure pan, no 'zoomend'), so an open
      // spiderfy fan is left undisturbed.
      const clampedZoom = computeClampedTargetZoom(currentZoom, targetZoom);

      // Calculate the pixel point to pan to
      const targetPoint = map.project(centerTarget, clampedZoom);
      const offsetPoint = targetPoint.subtract([0, panOffset]);
      const offsetLatLng = map.unproject(offsetPoint, clampedZoom);

      // #4046 item 3: scale the animation duration by the size of the zoom
      // jump — a big zoomed-out-to-street jump gets a proportionally longer,
      // smoother animation instead of a jarring snap; a small adjustment
      // stays quick.
      const duration = computeZoomAnimationDuration(currentZoom, clampedZoom);

      // Use setView with the offset position in a single operation
      // This avoids multiple move events and competing animations
      map.setView(offsetLatLng, clampedZoom, { animate: true, duration });

      // Reset target after animation completes (slightly longer than the
      // actual animation duration, which now varies with the zoom jump).
      const timer = setTimeout(() => {
        onCenterComplete();
      }, duration * 1000 + 50);

      return () => clearTimeout(timer);
    }
  }, [centerTarget, onCenterComplete, map, targetZoom]);

  return null;
};
