/**
 * Component to manage marker spiderfier for handling overlapping markers
 * Must be used as a child of MapContainer to access the map instance
 */

import { useImperativeHandle, forwardRef } from 'react';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';
import { useMarkerSpiderfier } from '../hooks/useMarkerSpiderfier';

interface SpiderfierControllerProps {
  /**
   * Current zoom level of the map
   * Used to adjust spiderfier behavior based on zoom
   */
  zoomLevel: number;
}

export interface SpiderfierControllerRef {
  addMarker: (marker: LeafletMarker | null, nodeId?: string) => void;
  removeMarker: (marker: LeafletMarker | null) => void;
  addListener: <K extends keyof SpiderfierEventMap>(
    event: K,
    handler: SpiderfierEventHandler<K>
  ) => void;
  removeListener: <K extends keyof SpiderfierEventMap>(
    event: K,
    handler: SpiderfierEventHandler<K>
  ) => void;
  getSpiderfier: () => OverlappingMarkerSpiderfier | null;
}

export const SpiderfierController = forwardRef<SpiderfierControllerRef, SpiderfierControllerProps>(
  ({}, ref) => {
    // Use a generous fixed nearbyDistance to ensure overlapping markers are detected
    // at all zoom levels. 50 pixels is enough to catch markers at the same GPS coordinates
    // while avoiding false positives from nearby but distinct locations
    const nearbyDistance = 50;

    const { addMarker, removeMarker, addListener, removeListener, getSpiderfier } = useMarkerSpiderfier({
      keepSpiderfied: true, // Keep markers fanned out after clicking
      nearbyDistance: nearbyDistance,
      circleSpiralSwitchover: 9, // Use spiral layout for 9+ markers
      circleFootSeparation: 50, // Increased from default 25 to spread markers further apart
      spiralFootSeparation: 50, // Increased from default 28 to spread markers further apart
      spiralLengthStart: 20, // Increased from default 11 to start spiral further from center
      spiralLengthFactor: 8, // Increased from default 5 for faster spiral growth
      legWeight: 2,
      legColors: {
        usual: 'rgba(100, 100, 100, 0.6)', // Semi-transparent gray
        highlighted: 'rgba(50, 50, 50, 0.8)', // Darker when hovering
      },
    });

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      addMarker,
      removeMarker,
      addListener,
      removeListener,
      getSpiderfier,
    }), [addMarker, removeMarker, addListener, removeListener, getSpiderfier]);

    // This component doesn't render anything
    return null;
  }
);
