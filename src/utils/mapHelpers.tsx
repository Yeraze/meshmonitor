import React from 'react';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import { ROLE_NAMES } from '../constants';

// Constants for arrow generation
export const ARROW_DISTANCE_THRESHOLD = 0.05; // One arrow per 0.05 degrees
export const MIN_ARROWS_PER_SEGMENT = 1;
export const MAX_ARROWS_PER_SEGMENT = 5;
export const MAX_TOTAL_ARROWS = 50; // Global limit to prevent performance issues
export const ARROW_ROTATION_OFFSET = 0; // Degrees to rotate arrow to point forward

/**
 * Convert role number/string to readable role name
 */
export const getRoleName = (role: number | string | undefined): string | null => {
  if (role === undefined || role === null) return null;
  const roleNum = typeof role === 'string' ? parseInt(role, 10) : role;
  if (isNaN(roleNum)) return null;
  return ROLE_NAMES[roleNum] || `Role ${roleNum}`;
};

/**
 * Parse role from string or number with validation
 */
export const parseRoleNumber = (role: string | number | undefined): number => {
  if (role === undefined || role === null) return 0;
  const roleNum = typeof role === 'string'
    ? parseInt(role, 10)
    : (typeof role === 'number' ? role : 0);
  return isNaN(roleNum) ? 0 : roleNum;
};

/**
 * Generate arrow markers along a path to indicate direction
 *
 * @param positions Array of [lat, lng] coordinates defining the path
 * @param pathKey Unique key prefix for the markers
 * @param color Color of the arrow markers
 * @param currentArrowCount Current count of arrows to enforce global limit
 * @returns Array of Marker components with arrow icons
 */
export const generateArrowMarkers = (
  positions: [number, number][],
  pathKey: string,
  color: string,
  currentArrowCount: number
): React.ReactElement[] => {
  const arrows: React.ReactElement[] = [];
  let arrowsGenerated = 0;

  for (let i = 0; i < positions.length - 1 && currentArrowCount + arrowsGenerated < MAX_TOTAL_ARROWS; i++) {
    const start = positions[i];
    const end = positions[i + 1];

    // Calculate distance to determine number of arrows
    const latDiff = end[0] - start[0];
    const lngDiff = end[1] - start[1];
    const distance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);

    // Calculate number of arrows for this segment
    const numArrows = Math.max(
      MIN_ARROWS_PER_SEGMENT,
      Math.min(MAX_ARROWS_PER_SEGMENT, Math.floor(distance / ARROW_DISTANCE_THRESHOLD))
    );

    // Limit arrows if we're approaching the global limit
    const arrowsToAdd = Math.min(numArrows, MAX_TOTAL_ARROWS - (currentArrowCount + arrowsGenerated));

    // Calculate angle for arrow direction (pointing from start to end)
    const angle = Math.atan2(lngDiff, latDiff) * 180 / Math.PI + ARROW_ROTATION_OFFSET;

    for (let j = 0; j < arrowsToAdd; j++) {
      // Distribute arrows evenly along the segment
      const t = (j + 1) / (arrowsToAdd + 1);
      const arrowLat = start[0] + latDiff * t;
      const arrowLng = start[1] + lngDiff * t;

      const arrowIcon = L.divIcon({
        html: `<div style="transform: rotate(${angle}deg); font-size: 20px; font-weight: bold;">
          <span style="color: ${color}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;">▲</span>
        </div>`,
        className: 'arrow-icon',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      arrows.push(
        <Marker
          key={`${pathKey}-arrow-${i}-${j}`}
          position={[arrowLat, arrowLng]}
          icon={arrowIcon}
        />
      );
      arrowsGenerated++;
    }
  }

  return arrows;
};
