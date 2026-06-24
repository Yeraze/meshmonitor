/**
 * React hook for managing Leaflet marker spiderfier
 * Handles spreading of overlapping markers in a "peacock fan" pattern
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';

/**
 * Shared spiderfier tuning used by every map surface (per-source NodesTab map,
 * Map Analysis, and the Unified/Dashboard map) so overlapping markers fan out
 * identically everywhere (issue #3612).
 *
 * These values come from the per-source NodesTab map (`SpiderfierController`),
 * which is the working reference. A 50px `nearbyDistance` is deliberately
 * larger than the library default (20px) so that co-located nodes — including
 * estimated-position nodes that collapse onto the same anchor point — are
 * reliably grouped and separable.
 */
export const SHARED_SPIDERFIER_OPTIONS: SpiderfierOptions = {
  /** Keep markers fanned out after clicking so each is individually selectable. */
  keepSpiderfied: true,
  /** Pixel radius for detecting overlapping markers — 50px catches markers at (near-)identical coords. */
  nearbyDistance: 50,
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

    // Flush any markers that registered before the spiderfier existed (their
    // ref callbacks ran during the commit phase, before this effect). Without
    // this, markers present at first mount are never handed to the spiderfier
    // and clicking their pile never spreads them apart.
    if (pendingRef.current.size > 0) {
      pendingRef.current.forEach((marker, key) => {
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

  return {
    addMarker,
    removeMarker,
    getSpiderfier,
    addListener,
    removeListener,
  };
}
