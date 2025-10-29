/**
 * React hook for managing Leaflet marker spiderfier
 * Handles spreading of overlapping markers in a "peacock fan" pattern
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';

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
    if (!marker || !spiderfierRef.current) {
      return;
    }

    // Track by node ID if provided, otherwise generate a unique key
    const trackingKey = nodeId || `marker-${Date.now()}-${Math.random()}`;
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
        // Same position - this is likely React-Leaflet recreating the marker
        // DON'T remove the old marker to preserve spiderfier state
        // Update tracking without touching spiderfier
        // The spiderfier will continue to work with the old marker object
        // This is safe because Leaflet markers at the same position are functionally identical
        return; // Keep the existing marker in the spiderfier
      } else {
        // Different position - truly a different marker
        try {
          spiderfierRef.current.removeMarker(existingMarker);
          markersRef.current.delete(existingMarker);
        } catch (e) {
          // Ignore removal errors
        }
      }
    }

    // Add the new marker
    try {
      spiderfierRef.current.addMarker(marker);
      markersRef.current.add(marker);
      markerByIdRef.current.set(trackingKey, marker);
    } catch (e) {
      console.warn('[Spiderfier] Failed to add marker:', e);
    }
  }, []);

  /**
   * Remove a marker from the spiderfier
   */
  const removeMarker = useCallback((marker: LeafletMarker | null) => {
    if (!marker || !spiderfierRef.current) return;

    if (!markersRef.current.has(marker)) return;

    try {
      spiderfierRef.current.removeMarker(marker);
      markersRef.current.delete(marker);
    } catch (e) {
      console.warn('Failed to remove marker from spiderfier:', e);
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
