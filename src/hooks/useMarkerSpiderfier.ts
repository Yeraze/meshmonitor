/**
 * React hook for managing Leaflet marker spiderfier
 * Handles spreading of overlapping markers in a "peacock fan" pattern
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useMap } from 'react-leaflet';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';
import {
  DEFAULT_TARGET_ZOOM,
  DEFAULT_ZOOM_GATE_THRESHOLD,
  computeClampedTargetZoom,
  computeZoomAnimationDuration,
} from '../utils/mapZoomAnimation';

export { DEFAULT_ZOOM_GATE_THRESHOLD };

/**
 * Minimal shape of `OverlappingMarkerSpiderfier`'s PRIVATE `spiderListener`
 * method that we deliberately reach into for issue #4046 item 1 (re-spiderfy
 * after zoom settles). The vendored library exposes no public "recompute the
 * fan for this marker" API — `spiderListener` is exactly what its own
 * per-marker 'click' handler calls (`ts-overlapping-marker-spiderfier-leaflet
 * @1.0.5`, `dist/index.cjs.js`): it searches for nearby markers around the
 * given marker AT THE CURRENT ZOOM and re-spiderfies them, which is exactly
 * "fresh geometry, never reused stale foot positions." A typed cast (not
 * `any`) — see the call site below for the full rationale.
 */
interface SpiderfierInternals {
  spiderListener(marker: LeafletMarker): void;
}

/**
 * Shared spiderfier tuning used by every map surface (per-source NodesTab map,
 * Map Analysis, and the Unified/Dashboard map) so overlapping markers fan out
 * identically everywhere (issue #3612).
 *
 * These values come from the per-source NodesTab map (`SpiderfierController`),
 * which is the working reference.
 *
 * `nearbyDistance` (issue #4199): the pixel radius OMS uses to decide, at click
 * time, which registered markers belong to the clicked marker's group — it
 * compares each marker's CURRENT `getLatLng()` (in layer pixels) against the
 * clicked marker's, purely by screen proximity. This was 50px, which is 2.5x
 * the library default (20px) and far wider than a marker's icon-overlap zone.
 * At that radius OMS pulled in — and, on a standalone hit, selected/opened the
 * popup of — a genuinely-separate, unrelated node that merely happened to sit
 * within 50px on screen, instead of fanning out the pile the user aimed at.
 * #4155 made this reachable in more places: a node alone in its precision cell
 * now renders at its true reported center (it used to always be jittered within
 * the cell), so an unrelated node can land at a fixed point close to an
 * intended cluster.
 *
 * 20px still reliably groups every pile that genuinely needs fanning, because
 * those are always within ~a marker's width of each other on screen:
 *  - exact-coincident anchors (estimated-position nodes, multi-source nodes at
 *    identical coords) are 0px apart — caught by any radius >= 1;
 *  - same-precision-cell piles overlap visually only at the low zooms where the
 *    accuracy cell (and thus the #4016 within-cell offset spread) collapses to a
 *    few pixels — also well within 20px. At higher zoom the within-cell offset
 *    already declutters them, so they no longer need a click to separate.
 * Markers 20-50px apart are visually distinct and individually clickable, so
 * excluding them from the group is the correct behavior, not a regression.
 */
export const SHARED_SPIDERFIER_OPTIONS: SpiderfierOptions = {
  /** Keep markers fanned out after clicking so each is individually selectable. */
  keepSpiderfied: true,
  /** Pixel radius for detecting overlapping markers — matches genuine icon
   *  overlap so a separate node up to 50px away isn't grouped/selected in place
   *  of the intended pile (issue #4199). (Near-)identical coords are 0px apart
   *  and always caught. */
  nearbyDistance: 20,
  /** Number of markers before switching from circle to spiral layout. */
  circleSpiralSwitchover: 9,
  /** Distance between markers in circle layout (pixels). */
  circleFootSeparation: 50,
  /** Distance between markers in spiral layout (pixels). */
  spiralFootSeparation: 50,
  /** Starting radius for spiral layout (pixels). */
  spiralLengthStart: 20,
  /** How quickly the spiral grows — higher = faster growth and more spacing. */
  spiralLengthFactor: 8,
  /** Line thickness for spider legs. */
  legWeight: 2,
  legColors: {
    usual: 'rgba(100, 100, 100, 0.6)', // Semi-transparent gray
    highlighted: 'rgba(50, 50, 50, 0.8)', // Darker when hovering
  },
  /** Issue #4046 item 4: below z13, don't register markers with the
   *  spiderfier at all — a click falls through to the native marker click,
   *  which `NodeMarkersLayer` wires to a "zoom in first" flow instead of
   *  spiderfying a large, hard-to-parse low-zoom pile. Applies to every
   *  surface that uses the shared layer (NodesTab, Dashboard, MeshCore,
   *  Map Analysis). */
  zoomGateThreshold: DEFAULT_ZOOM_GATE_THRESHOLD,
};

export interface SpiderfierOptions {
  /**
   * Keep markers spiderfied after clicking (default: false)
   */
  keepSpiderfied?: boolean;

  /**
   * Pixel radius for considering markers as overlapping (default: 20)
   * Higher values = more aggressive spiderfying
   */
  nearbyDistance?: number;

  /**
   * Number of markers before switching from circle to spiral layout (default: 9)
   */
  circleSpiralSwitchover?: number;

  /**
   * Distance between markers in circle layout (default: 25 pixels)
   * Higher values = more spread out
   */
  circleFootSeparation?: number;

  /**
   * Distance between markers in spiral layout (default: 28 pixels)
   * Higher values = more spread out
   */
  spiralFootSeparation?: number;

  /**
   * Starting radius for spiral layout (default: 11 pixels)
   * Higher values = start spiral further from center
   */
  spiralLengthStart?: number;

  /**
   * How quickly spiral grows (default: 5)
   * Higher values = faster growth
   */
  spiralLengthFactor?: number;

  /**
   * Line thickness for spider legs connecting markers to center (default: 1.5)
   */
  legWeight?: number;

  /**
   * Line color for spider legs (default: '#222')
   */
  legColors?: {
    usual: string;
    highlighted: string;
  };

  /**
   * Issue #4046 item 4: zoom level at/above which markers are registered
   * with the spiderfier. Below this, `addMarker` withholds registration
   * (the marker is still tracked, just not handed to OMS) and
   * `isAboveGateThreshold` / `handleGatedClick` let the consumer wire a
   * "zoom in first" click flow instead. Default: DEFAULT_ZOOM_GATE_THRESHOLD (13).
   */
  zoomGateThreshold?: number;

  /**
   * Target zoom used by `handleGatedClick`'s "zoom in first" flow (issue
   * #4046 items 2/4) — same clamp-never-zoom-out semantics as
   * `MapCenterController`'s `targetZoom`. Default: DEFAULT_TARGET_ZOOM (17).
   */
  zoomGateTargetZoom?: number;
}

/**
 * Hook to manage marker spiderfier for handling overlapping markers
 *
 * @param options - Configuration options for the spiderfier
 * @returns Object with methods to add/remove markers from spiderfier
 */
export function useMarkerSpiderfier(options: SpiderfierOptions = {}) {
  const map = useMap();
  const spiderfierRef = useRef<OverlappingMarkerSpiderfier | null>(null);
  const markersRef = useRef<Set<LeafletMarker>>(new Set());
  // Track markers by nodeId or leaflet ID to allow multiple markers at same location
  const markerByIdRef = useRef<Map<string, LeafletMarker>>(new Map());
  // Markers whose ref callback fired BEFORE the spiderfier instance existed.
  // React invokes <Marker ref> callbacks during the commit phase, which runs
  // *before* the `useEffect` below that creates the spiderfier. Any marker
  // present at first mount therefore arrives while `spiderfierRef.current` is
  // still null; without buffering it would be dropped and its overlapping pile
  // would never fan out (issue #3612 follow-up — Map Analysis / Unified maps,
  // whose node data is already present at first commit, hit exactly this).
  // These get flushed into the spiderfier the moment it's created.
  const pendingRef = useRef<Map<string, LeafletMarker>>(new Map());

  // #4046 item 4: markers withheld from the spiderfier because the zoom is
  // below `zoomGateThreshold`. Distinct from `pendingRef` (which is a
  // one-time pre-init buffer) — markers can move in and out of this set
  // repeatedly as the zoom crosses the gate.
  const gatedMarkersRef = useRef<Map<string, LeafletMarker>>(new Map());
  // Mirrors whether we're currently above the gate. A ref for synchronous
  // reads inside effect callbacks, plus `isAboveGateThreshold` state so
  // `NodeMarkersLayer` re-renders (to swap marker eventHandlers) when it
  // crosses.
  const aboveThresholdRef = useRef(true);
  const [isAboveGateThreshold, setIsAboveGateThreshold] = useState(true);

  // #4046 item 1: the last marker-group spiderfy'd, tracked so a fresh
  // zoomend can re-trigger the fan at the new zoom's geometry. Any marker
  // from the group works as the recompute anchor (spiderListener searches
  // for markers near IT, at the current zoom).
  const lastSpiderfiedAnchorRef = useRef<LeafletMarker | null>(null);
  // True between 'zoomstart' and our own 'zoomend' handler running. Lets the
  // 'unspiderfy' listener below tell a zoom-triggered collapse (OMS's own
  // unconditional zoomend->unspiderfy — keep the anchor, we're about to
  // re-spiderfy it) apart from a deliberate one (click-away, or clicking a
  // different marker — drop the anchor, nothing to re-spiderfy).
  const zoomChangeInProgressRef = useRef(false);

  // `addMarker`/`removeMarker`/`handleGatedClick` are deliberately
  // referentially stable (`[]` deps — see the comment above `addMarker`'s
  // definition), because `NodeMarkersLayer` caches its per-marker ref
  // callback once per key and never rebinds it. That means those callbacks
  // can only read *current* option values through a ref, not through the
  // `options` closure directly (which would go stale, or — worse — force us
  // to break referential stability by adding `options.x` to their deps).
  // Synced on every render (no dependency array) rather than only when
  // `options` changes, since callers may pass a fresh object literal each
  // render even when the underlying values are unchanged.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  // Same rationale as `optionsRef` — `map` is stable in practice (one
  // `useMap()` context per mounted MapContainer), but capturing it directly
  // in a `[]`-dep callback trips `react-hooks/exhaustive-deps`. Route through
  // a ref instead of adding `map` to addMarker's deps (which would break its
  // required referential stability).
  const mapRef = useRef(map);
  useEffect(() => {
    mapRef.current = map;
  });

  // Initialize spiderfier instance (only once when map is available)
  useEffect(() => {
    if (!map) return;

    // Create spiderfier with initial options
    const spiderfier = new OverlappingMarkerSpiderfier(map, {
      keepSpiderfied: options.keepSpiderfied ?? true, // Keep markers fanned out
      nearbyDistance: options.nearbyDistance ?? 20,
      circleSpiralSwitchover: options.circleSpiralSwitchover ?? 9,
      circleFootSeparation: options.circleFootSeparation ?? 25,
      spiralFootSeparation: options.spiralFootSeparation ?? 28,
      spiralLengthStart: options.spiralLengthStart ?? 11,
      spiralLengthFactor: options.spiralLengthFactor ?? 5,
      legWeight: options.legWeight ?? 2,
      legColors: options.legColors ?? {
        usual: 'rgba(100, 100, 100, 0.6)',
        highlighted: 'rgba(50, 50, 50, 0.8)',
      },
    });

    spiderfierRef.current = spiderfier;

    // #4046 item 1: track the last-spiderfied group so a subsequent zoomend
    // can recompute a fresh fan for it (see the zoomend handler below).
    const handleSpiderfy = (spiderfiedMarkers: LeafletMarker[]) => {
      lastSpiderfiedAnchorRef.current = spiderfiedMarkers[0] ?? null;
    };
    const handleUnspiderfy = () => {
      // Only drop the tracked anchor when this collapse was NOT caused by a
      // zoom change (e.g. the user clicked empty map space to close the fan,
      // or clicked a different marker — OMS unspiderfies any existing fan
      // before spiderfying a new one). A zoom-triggered collapse leaves the
      // anchor in place so the zoomend handler can re-spiderfy the same
      // group at the new zoom.
      if (!zoomChangeInProgressRef.current) {
        lastSpiderfiedAnchorRef.current = null;
      }
    };
    spiderfier.addListener('spiderfy', handleSpiderfy);
    spiderfier.addListener('unspiderfy', handleUnspiderfy);

    // Initialize the zoom-gate state from the current zoom (#4046 item 4).
    const threshold = options.zoomGateThreshold;
    const initiallyAbove = threshold == null || map.getZoom() >= threshold;
    aboveThresholdRef.current = initiallyAbove;
    setIsAboveGateThreshold(initiallyAbove);

    // Flush any markers that registered before the spiderfier existed (their
    // ref callbacks ran during the commit phase, before this effect). Without
    // this, markers present at first mount are never handed to the spiderfier
    // and clicking their pile never spreads them apart.
    if (pendingRef.current.size > 0) {
      pendingRef.current.forEach((marker, key) => {
        if (!initiallyAbove) {
          // Below the gate at first mount — withhold registration, matching
          // the steady-state addMarker() behavior.
          gatedMarkersRef.current.set(key, marker);
          return;
        }
        try {
          spiderfier.addMarker(marker);
          markersRef.current.add(marker);
          markerByIdRef.current.set(key, marker);
        } catch {
          // Ignore — a marker may have been removed before flush.
        }
      });
      pendingRef.current.clear();
    }

    // Cleanup on unmount
    return () => {
      if (spiderfierRef.current) {
        // Remove all markers
        markersRef.current.forEach(marker => {
          try {
            spiderfierRef.current?.removeMarker(marker);
          } catch (e) {
            // Ignore errors during cleanup
          }
        });
        markersRef.current.clear();
        markerByIdRef.current.clear();
        pendingRef.current.clear();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- #4046 mirrors the pre-existing markersRef/markerByIdRef/pendingRef cleanup lines above (baselined): these are plain Map/Set refs, not DOM nodes, so the "ref may have changed by cleanup time" warning is a false positive here.
        gatedMarkersRef.current.clear();
        lastSpiderfiedAnchorRef.current = null;
        spiderfierRef.current = null;
      }
    };
  }, [map]); // Only recreate when map changes, not on every option change

  // Update nearbyDistance when it changes (without recreating the entire instance)
  useEffect(() => {
    if (spiderfierRef.current && options.nearbyDistance !== undefined) {
      spiderfierRef.current.nearbyDistance = options.nearbyDistance;
    }
  }, [options.nearbyDistance]);

  // #4046 items 1 + 4: on 'zoomstart', snapshot that a zoom is in progress
  // (read by the 'unspiderfy' listener above to distinguish a zoom-triggered
  // collapse from a deliberate one). On 'zoomend':
  //   - if the zoom-gate threshold was just crossed, (de)register every
  //     tracked marker accordingly (item 4);
  //   - if a fan was open immediately before this zoom change and we're
  //     still above the gate, recompute it fresh at the new zoom (item 1) —
  //     the vendored OMS unconditionally unspiderfies on its own 'zoomend'
  //     listener (registered first, inside its constructor), so by the time
  //     this handler runs the fan is already collapsed; we're re-triggering
  //     a brand new spiderfy computation, never reusing the stale geometry.
  useEffect(() => {
    if (!map) return;

    const handleZoomStart = () => {
      zoomChangeInProgressRef.current = true;
    };

    const handleZoomEnd = () => {
      zoomChangeInProgressRef.current = false;

      const spiderfier = spiderfierRef.current;
      if (!spiderfier) return;

      const threshold = options.zoomGateThreshold;
      if (threshold != null) {
        const nowAbove = map.getZoom() >= threshold;
        if (nowAbove !== aboveThresholdRef.current) {
          aboveThresholdRef.current = nowAbove;
          setIsAboveGateThreshold(nowAbove);

          if (nowAbove) {
            // Crossed up: register every withheld marker.
            gatedMarkersRef.current.forEach((marker, key) => {
              try {
                spiderfier.addMarker(marker);
                markersRef.current.add(marker);
                markerByIdRef.current.set(key, marker);
              } catch {
                // Ignore — marker may have been unmounted while gated.
              }
            });
            gatedMarkersRef.current.clear();
          } else {
            // Crossed down: deregister everything so a low-zoom click falls
            // through to the native marker click (zoom-in-first flow, #4046
            // item 4) instead of spiderfying a large pile.
            markersRef.current.forEach(marker => {
              try {
                spiderfier.removeMarker(marker);
              } catch {
                // Ignore
              }
            });
            markerByIdRef.current.forEach((marker, key) => {
              gatedMarkersRef.current.set(key, marker);
            });
            markersRef.current.clear();
            markerByIdRef.current.clear();
            // Nothing can be spiderfied below the gate — drop the tracked
            // anchor so crossing back up later doesn't resurrect a stale fan.
            lastSpiderfiedAnchorRef.current = null;
          }
        }
      }

      const anchor = lastSpiderfiedAnchorRef.current;
      if (anchor && markersRef.current.has(anchor)) {
        // Reach into the vendored library's private `spiderListener` — the
        // exact method its own marker 'click' handler calls. There's no
        // public "recompute this fan" API; this typed cast (not `any`) is
        // the documented, deliberate exception (see SpiderfierInternals
        // above). Calling it re-derives the nearby-marker group from the
        // anchor's position AT THE CURRENT (new) ZOOM and re-spiderfies —
        // fresh foot positions, never the stale pre-zoom ones.
        (spiderfier as unknown as SpiderfierInternals).spiderListener(anchor);
      }
    };

    map.on('zoomstart', handleZoomStart);
    map.on('zoomend', handleZoomEnd);
    return () => {
      map.off('zoomstart', handleZoomStart);
      map.off('zoomend', handleZoomEnd);
    };
  }, [map, options.zoomGateThreshold]);

  /**
   * Add a marker to the spiderfier
   * @param marker - The Leaflet marker instance
   * @param nodeId - Optional node ID to track this marker (allows multiple markers at same position)
   */
  const addMarker = useCallback((marker: LeafletMarker | null, nodeId?: string) => {
    if (!marker) {
      return;
    }

    // Track by node ID if provided, otherwise generate a unique key
    const trackingKey = nodeId || `marker-${Date.now()}-${Math.random()}`;

    // Spiderfier not created yet (ref callback fired during the commit phase,
    // before the init effect). Buffer the marker; the init effect flushes it.
    if (!spiderfierRef.current) {
      pendingRef.current.set(trackingKey, marker);
      return;
    }

    // #4046 item 4: below the zoom-gate threshold, track the marker but
    // withhold it from the spiderfier entirely — no live OMS registration to
    // dedupe/replace, so this is a simple upsert. The zoomend handler above
    // registers it once the zoom crosses back above the threshold.
    const threshold = optionsRef.current.zoomGateThreshold;
    if (threshold != null && mapRef.current && mapRef.current.getZoom() < threshold) {
      gatedMarkersRef.current.set(trackingKey, marker);
      return;
    }
    gatedMarkersRef.current.delete(trackingKey);

    const existingMarker = markerByIdRef.current.get(trackingKey);

    // If the existing marker is the same object, we're done (already added)
    if (existingMarker === marker) {
      return;
    }

    // If there's a different marker for this node ID, we need to check if it's truly different
    // or just a React-Leaflet re-creation at the same position
    if (existingMarker && existingMarker !== marker) {
      const existingLatLng = existingMarker.getLatLng();
      const newLatLng = marker.getLatLng();
      const isSamePosition =
        existingLatLng.lat === newLatLng.lat &&
        existingLatLng.lng === newLatLng.lng;

      if (isSamePosition) {
        // Same position but different object - React-Leaflet recreated the marker
        // (e.g., after Popup child mounts/unmounts from showRoute toggle).
        // We must replace the old marker so the spiderfier's click listener
        // is registered on the marker that's actually on the map.
        try {
          spiderfierRef.current.removeMarker(existingMarker);
          markersRef.current.delete(existingMarker);
          markerByIdRef.current.delete(trackingKey);
        } catch (e) {
          // Log but don't fail - we'll add the new marker anyway
        }
        // Fall through to add the new marker below
      } else {
        // Different position - truly a different marker, remove the old one
        try {
          spiderfierRef.current.removeMarker(existingMarker);
          markersRef.current.delete(existingMarker);
          markerByIdRef.current.delete(trackingKey);
        } catch (e) {
          // Log but don't fail - we'll add the new marker anyway
          const error = e instanceof Error ? e : new Error(String(e));
          console.warn('[Spiderfier] Failed to remove old marker during position change:', {
            nodeId,
            error: error.message,
          });
        }
      }
    }

    // Add the new marker
    try {
      spiderfierRef.current.addMarker(marker);
      markersRef.current.add(marker);
      markerByIdRef.current.set(trackingKey, marker);
    } catch (e) {
      // Log detailed error information for debugging
      const error = e instanceof Error ? e : new Error(String(e));
      console.error('[Spiderfier] Failed to add marker:', {
        nodeId,
        position: marker.getLatLng(),
        error: error.message,
        stack: error.stack,
      });
    }
  }, []);

  /**
   * Remove a marker from the spiderfier
   */
  const removeMarker = useCallback((marker: LeafletMarker | null) => {
    if (!marker) return;

    // Drop it from the pre-init buffer too, so a marker unmounted before the
    // spiderfier was created isn't resurrected by the flush.
    for (const [key, value] of pendingRef.current.entries()) {
      if (value === marker) {
        pendingRef.current.delete(key);
        break;
      }
    }

    // #4046 item 4: also purge the zoom-gate withheld set — a node that
    // ages out/filters away while below the gate must not be resurrected
    // (pointing at a stale, unmounted marker) when the zoom later crosses
    // back above the threshold.
    for (const [key, value] of gatedMarkersRef.current.entries()) {
      if (value === marker) {
        gatedMarkersRef.current.delete(key);
        break;
      }
    }

    if (!spiderfierRef.current) return;

    if (!markersRef.current.has(marker)) return;

    try {
      spiderfierRef.current.removeMarker(marker);
      markersRef.current.delete(marker);

      // Clean up markerByIdRef to prevent memory leaks
      // Find and remove the entry for this marker
      for (const [key, value] of markerByIdRef.current.entries()) {
        if (value === marker) {
          markerByIdRef.current.delete(key);
          break;
        }
      }
    } catch (e) {
      // Log detailed error for debugging, but don't throw - removal failures during cleanup are tolerable
      const error = e instanceof Error ? e : new Error(String(e));
      console.warn('[Spiderfier] Failed to remove marker:', {
        position: marker.getLatLng(),
        error: error.message,
      });
    }
  }, []);

  /**
   * Get the spiderfier instance (for advanced usage)
   */
  const getSpiderfier = useCallback(() => {
    return spiderfierRef.current;
  }, []);

  /**
   * Add an event listener to the spiderfier
   * Events: 'click', 'spiderfy', 'unspiderfy'
   */
  const addListener = useCallback(<K extends keyof SpiderfierEventMap>(
    event: K,
    handler: SpiderfierEventHandler<K>
  ) => {
    if (!spiderfierRef.current) {
      console.warn('[Spiderfier] Cannot add listener: spiderfier not initialized');
      return;
    }
    spiderfierRef.current.addListener(event, handler);
  }, []);

  /**
   * Remove an event listener from the spiderfier
   */
  const removeListener = useCallback(<K extends keyof SpiderfierEventMap>(
    event: K,
    handler: SpiderfierEventHandler<K>
  ) => {
    if (!spiderfierRef.current) {
      return;
    }
    spiderfierRef.current.removeListener(event, handler);
  }, []);

  /**
   * Issue #4046 item 4: the "zoom in first" click handler for a marker that
   * is below the zoom-gate threshold (and therefore NOT registered with the
   * spiderfier — its native Leaflet click never reaches OMS). Consumers
   * (`NodeMarkersLayer`) wire this as the marker's `click` eventHandler
   * while `isAboveGateThreshold` is false, in place of the marker's normal
   * click behavior — no selection, no popup, just center-and-zoom so the
   * pile is sparse enough to click precisely on a follow-up click. Reuses
   * the same clamp-never-zoom-out + duration-scaling math as
   * `MapCenterController` (items 2/3), invoked directly against the map
   * rather than through each consumer's own center-on-node plumbing, so
   * every map surface gets identical below-threshold behavior for free.
   */
  const handleGatedClick = useCallback((marker: LeafletMarker) => {
    if (!map) return;
    const currentZoom = map.getZoom();
    const targetZoom = optionsRef.current.zoomGateTargetZoom ?? DEFAULT_TARGET_ZOOM;
    const clampedZoom = computeClampedTargetZoom(currentZoom, targetZoom);
    const duration = computeZoomAnimationDuration(currentZoom, clampedZoom);
    map.setView(marker.getLatLng(), clampedZoom, { animate: true, duration });
  }, [map]);

  return {
    addMarker,
    removeMarker,
    getSpiderfier,
    addListener,
    removeListener,
    /** True when at/above `zoomGateThreshold` (or gating is disabled) —
     *  markers are registered with the spiderfier and click normally. False
     *  below the threshold — markers are withheld and `NodeMarkersLayer`
     *  should route clicks through `handleGatedClick` instead (#4046 item 4). */
    isAboveGateThreshold,
    handleGatedClick,
  };
}
