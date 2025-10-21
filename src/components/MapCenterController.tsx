import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';

interface MapCenterControllerProps {
  centerTarget: [number, number] | null;
  onCenterComplete: () => void;
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
  onCenterComplete
}) => {
  const map = useMap();

  useEffect(() => {
    if (centerTarget) {
      // Listen for moveend event after setView completes, then pan to show popup
      map.once('moveend', () => {
        // Pan the map down by 150 pixels to account for popup height
        // This ensures both the marker and the popup above it are fully visible
        map.panBy([0, -150], { animate: true, duration: 0.3 });
      });

      map.setView(centerTarget, 15); // Zoom level 15 for close view
      onCenterComplete(); // Reset target after centering
    }
  }, [centerTarget, onCenterComplete, map]);

  return null;
};
