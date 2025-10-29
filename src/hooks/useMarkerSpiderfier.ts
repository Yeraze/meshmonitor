/**
 * React hook for managing Leaflet marker spiderfier
 * Handles spreading of overlapping markers in a "peacock fan" pattern
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMap } from 'react-leaflet';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier } from 'ts-overlapping-marker-spiderfier-leaflet';

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

  // Initialize spiderfier instance
  useEffect(() => {
    if (!map) return;

    // Create spiderfier with options
    const spiderfier = new OverlappingMarkerSpiderfier(map, {
      keepSpiderfied: options.keepSpiderfied ?? false,
      nearbyDistance: options.nearbyDistance ?? 20,
      circleSpiralSwitchover: options.circleSpiralSwitchover ?? 9,
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
        spiderfierRef.current = null;
      }
    };
  }, [map, options.keepSpiderfied, options.nearbyDistance, options.circleSpiralSwitchover, options.legWeight]);

  /**
   * Add a marker to the spiderfier
   */
  const addMarker = useCallback((marker: LeafletMarker | null) => {
    if (!marker || !spiderfierRef.current) return;

    // Don't add if already added
    if (markersRef.current.has(marker)) return;

    try {
      spiderfierRef.current.addMarker(marker);
      markersRef.current.add(marker);
    } catch (e) {
      console.warn('Failed to add marker to spiderfier:', e);
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

  return {
    addMarker,
    removeMarker,
    getSpiderfier,
  };
}
