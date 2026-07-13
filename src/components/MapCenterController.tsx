import React, { useEffect, useRef } from 'react';
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

  // Defensive: center exactly once per distinct target. Without this, any
  // consumer that passes an unstable `onCenterComplete` (a dependency below)
  // would re-run this effect on every render and re-fire setView while
  // `centerTarget` is still set — snapping the map back so the user can't pan
  // (regression made severe by the #4046 variable animation duration widening
  // the reset window). Tracking the last-centered target makes this robust
  // regardless of callback stability.
  const lastCenteredRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (centerTarget) {
      // Skip if we've already centered on this exact target — only a genuinely
      // new target should move the map.
      if (
        lastCenteredRef.current &&
        lastCenteredRef.current[0] === centerTarget[0] &&
        lastCenteredRef.current[1] === centerTarget[1]
      ) {
        return;
      }
      lastCenteredRef.current = centerTarget;
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

      // A real user gesture during the center window must WIN. The animated
      // setView keeps the map "arriving" at the node for the whole `duration`
      // (up to ~2s for a big zoom jump, #4046), and `centerTarget` stays armed
      // until the timer below fires. A wheel/pinch/drag in that window would
      // otherwise be fought by the in-flight animation continuing to the node —
      // i.e. "any attempt to adjust zoom resets to the node." On the first
      // genuine user input we `map.stop()` (cancel our animation so it can't
      // pull the view back) and finish immediately (clear the armed target).
      // These DOM events fire ONLY for real interaction — our programmatic
      // setView never dispatches them — and the selecting click/tap's own
      // events have already fired by the time this effect runs, so we never
      // self-abort the very selection that started the centering.
      const container = map.getContainer();
      let timer = 0;
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        container.removeEventListener('wheel', onUserGesture);
        container.removeEventListener('touchstart', onUserGesture);
        container.removeEventListener('pointerdown', onUserGesture);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        onCenterComplete();
      };
      function onUserGesture() {
        map.stop(); // halt the in-flight center animation so it can't pull back
        finish();
      }
      container.addEventListener('wheel', onUserGesture, { passive: true });
      container.addEventListener('touchstart', onUserGesture, { passive: true });
      container.addEventListener('pointerdown', onUserGesture, { passive: true });

      // Reset target after animation completes (slightly longer than the
      // actual animation duration, which now varies with the zoom jump) unless
      // a user gesture finished it first.
      timer = window.setTimeout(finish, duration * 1000 + 50);

      return cleanup;
    } else {
      // Target cleared — allow the next selection (even of the same node) to
      // center again.
      lastCenteredRef.current = null;
    }
  }, [centerTarget, onCenterComplete, map, targetZoom]);

  return null;
};
