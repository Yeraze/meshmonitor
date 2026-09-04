import React, { useCallback, useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';

/**
 * Delay between "the box changed" and `invalidateSize()`.
 *
 * Two reasons it is not zero:
 *  - CSS transitions (the node-list collapse, the packet-monitor drawer) are
 *    still animating when the trigger prop flips.
 *  - A phone rotation is not one event. iOS fires a burst of resizes while the
 *    viewport is mid-transition and reports an in-between box for a few hundred
 *    ms; invalidating on the first one bakes in the transitional size.
 */
export const MAP_RESIZE_SETTLE_MS = 300;

interface MapResizeHandlerProps {
  /**
   * Caller-owned layout state. When it changes, the map is invalidated. Used
   * for *internal* layout toggles (list collapse, drawer height) that a
   * container observer cannot see ahead of the transition.
   *
   * Optional: viewport-driven invalidation below works without it.
   */
  trigger?: unknown;
  /** Override the settle delay. Tests only; production uses the default. */
  settleMs?: number;
}

/**
 * Keeps a Leaflet map's idea of its own size in step with the box it is
 * actually painted into.
 *
 * Leaflet caches the container size at load and only recomputes on
 * `invalidateSize()`. Anything that resizes the container behind its back — a
 * phone rotation, browser chrome sliding away, a split-view drag, a sidebar
 * collapsing — leaves it drawing tiles for the old box: the map fills part of
 * the viewport and the rest is grey (#5054).
 *
 * Mechanism: a `ResizeObserver` on the map's own container. That is the one
 * signal that covers every cause at once — orientation change, browser chrome,
 * split view, and container-driven layout shifts — and, unlike
 * `window.orientationchange`, it reports the box we actually care about rather
 * than a device-level event that may fire before layout settles.
 *
 * `orientationchange` is still bound as a safety net (some WebViews throttle
 * observer callbacks during the rotation animation), and `resize` is bound only
 * where `ResizeObserver` is missing. All three feed one debounced scheduler, so
 * a rotation burst produces exactly one `invalidateSize()`.
 */
const MapResizeHandler: React.FC<MapResizeHandlerProps> = ({
  trigger,
  settleMs = MAP_RESIZE_SETTLE_MS,
}) => {
  const map = useMap();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flipped by the unmount cleanup so an in-flight timer can never touch a map
  // Leaflet has already torn down.
  const aliveRef = useRef(true);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!aliveRef.current || !map) return;
      // `remove()` detaches the container; invalidating a detached map throws
      // on some Leaflet paths and is pointless on all of them.
      const container = map.getContainer?.();
      if (!container || container.isConnected === false) return;
      map.invalidateSize();
    }, settleMs);
  }, [map, settleMs]);

  // Own the alive flag and the timer for the component's whole lifetime, so a
  // re-run of either effect below cannot clear it out from under the other.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // ---- Caller-driven path (unchanged behaviour) ----------------------------
  useEffect(() => {
    // Omitted prop ⇒ this path stays dormant, exactly as when BaseMap gated the
    // whole handler on `resizeTrigger !== undefined`.
    if (trigger === undefined) return;
    schedule();
  }, [trigger, schedule]);

  // ---- Viewport-driven path (#5054) ---------------------------------------
  useEffect(() => {
    // `map` is non-null in production, but a react-leaflet `useMap` mock can
    // hand back null and must not crash the render (MapAnalysisCanvas.test).
    const container = map?.getContainer?.();
    const hasResizeObserver = typeof ResizeObserver !== 'undefined';

    let observer: ResizeObserver | null = null;
    if (container && hasResizeObserver) {
      // The first callback is the initial observation, not a change. Recording
      // it without scheduling keeps mount behaviour identical to before.
      let lastWidth = container.clientWidth;
      let lastHeight = container.clientHeight;
      observer = new ResizeObserver(() => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        const changed =
          Math.abs(width - lastWidth) > 0.5 || Math.abs(height - lastHeight) > 0.5;
        lastWidth = width;
        lastHeight = height;
        if (changed) schedule();
      });
      observer.observe(container);
    }

    if (typeof window === 'undefined') {
      return () => observer?.disconnect();
    }

    const onViewportChange = () => schedule();
    window.addEventListener('orientationchange', onViewportChange);
    // Only where the observer cannot do the job — otherwise this is pure
    // duplication of a signal we already have, on the noisiest event there is.
    if (!hasResizeObserver) {
      window.addEventListener('resize', onViewportChange);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('orientationchange', onViewportChange);
      if (!hasResizeObserver) {
        window.removeEventListener('resize', onViewportChange);
      }
    };
  }, [map, schedule]);

  return null;
};

export default MapResizeHandler;
