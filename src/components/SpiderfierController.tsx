/**
 * Component to manage marker spiderfier for handling overlapping markers
 * Must be used as a child of MapContainer to access the map instance
 */

import { useImperativeHandle, forwardRef } from 'react';
import { Marker as LeafletMarker } from 'leaflet';
import { useMarkerSpiderfier } from '../hooks/useMarkerSpiderfier';

interface SpiderfierControllerProps {
  /**
   * Current zoom level of the map
   * Used to adjust spiderfier behavior based on zoom
   */
  zoomLevel: number;
}

export interface SpiderfierControllerRef {
  addMarker: (marker: LeafletMarker | null) => void;
  removeMarker: (marker: LeafletMarker | null) => void;
}

export const SpiderfierController = forwardRef<SpiderfierControllerRef, SpiderfierControllerProps>(
  ({ zoomLevel }, ref) => {
    // Initialize spiderfier with adaptive configuration
    // nearbyDistance adapts based on zoom level
    // At higher zoom, markers need to be closer to trigger spiderfying
    const baseDistance = 20; // pixels at zoom 10
    const zoomAdjustedDistance = Math.max(10, baseDistance * Math.pow(0.9, zoomLevel - 10));

    const { addMarker, removeMarker } = useMarkerSpiderfier({
      keepSpiderfied: false, // Collapse fan when clicking elsewhere
      nearbyDistance: zoomAdjustedDistance,
      circleSpiralSwitchover: 9, // Use spiral layout for 9+ markers
      legWeight: 2,
      legColors: {
        usual: 'rgba(100, 100, 100, 0.6)', // Semi-transparent gray
        highlighted: 'rgba(50, 50, 50, 0.8)', // Darker when hovering
      },
    });

    // Expose addMarker and removeMarker methods via ref
    useImperativeHandle(ref, () => ({
      addMarker,
      removeMarker,
    }), [addMarker, removeMarker]);

    // This component doesn't render anything
    return null;
  }
);
