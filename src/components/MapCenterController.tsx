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
      // Get the map container height to calculate the center offset
      const mapContainer = map.getContainer();
      const mapHeight = mapContainer.clientHeight;

      // We want the popup (which appears above the marker) centered in viewport
      // To do this, the marker needs to be below center
      // In Leaflet's pixel coordinate system, Y increases downward
      // So to move the target point UP in screen space, we SUBTRACT from Y
      const panOffset = Math.floor(mapHeight / 4);

      // Calculate the pixel point to pan to
      const targetPoint = map.project(centerTarget, 15);
      const offsetPoint = targetPoint.subtract([0, panOffset]);
      const offsetLatLng = map.unproject(offsetPoint, 15);

      // Use setView with the offset position in a single operation
      // This avoids multiple move events and competing animations
      map.setView(offsetLatLng, 15, { animate: true, duration: 0.5 });

      // Reset target after animation completes
      setTimeout(() => {
        onCenterComplete();
      }, 550); // Slightly longer than animation duration
    }
  }, [centerTarget, onCenterComplete, map]);

  return null;
};
