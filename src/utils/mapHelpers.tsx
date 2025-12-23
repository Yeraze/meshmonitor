import React from 'react';
import L from 'leaflet';
import { Marker, Tooltip } from 'react-leaflet';

// Constants for arrow generation
const ARROW_DISTANCE_THRESHOLD = 0.05; // One arrow per 0.05 degrees
const MIN_ARROWS_PER_SEGMENT = 1;
const MAX_ARROWS_PER_SEGMENT = 5;
const MAX_TOTAL_ARROWS = 50; // Global limit to prevent performance issues
const ARROW_ROTATION_OFFSET = 0; // Degrees to rotate arrow to point forward

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

/**
 * Generate curved path between two points (quadratic bezier approximation)
 * curvature: positive = curve to the "left" side (relative to direction), negative = curve to "right"
 * To ensure forward and back paths curve in opposite directions consistently,
 * we normalize direction based on comparing start/end coordinates
 */
export const generateCurvedPath = (
  start: [number, number],
  end: [number, number],
  curvature: number = 0.15,
  segments: number = 20,
  normalizeDirection: boolean = false
): [number, number][] => {
  const points: [number, number][] = [];

  // If normalizeDirection is true, we ensure the curvature is consistent
  // regardless of which direction we're traveling
  let effectiveCurvature = curvature;
  if (normalizeDirection) {
    // Always curve based on "canonical" direction (lower lat/lng to higher)
    // This ensures forward A->B and back B->A curve on opposite sides
    const shouldFlip = start[0] > end[0] || (start[0] === end[0] && start[1] > end[1]);
    if (shouldFlip) {
      effectiveCurvature = -curvature;
    }
  }

  // Calculate perpendicular offset for control point
  const midLat = (start[0] + end[0]) / 2;
  const midLng = (start[1] + end[1]) / 2;

  // Vector from start to end
  const dx = end[1] - start[1];
  const dy = end[0] - start[0];
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length === 0) return [start, end];

  // Perpendicular vector (normalized) * curvature * length
  const perpLat = (-dx / length) * effectiveCurvature * length;
  const perpLng = (dy / length) * effectiveCurvature * length;

  // Control point
  const ctrlLat = midLat + perpLat;
  const ctrlLng = midLng + perpLng;

  // Generate points along quadratic bezier curve
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const t1 = 1 - t;

    // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
    const lat = t1 * t1 * start[0] + 2 * t1 * t * ctrlLat + t * t * end[0];
    const lng = t1 * t1 * start[1] + 2 * t1 * t * ctrlLng + t * t * end[1];

    points.push([lat, lng]);
  }

  return points;
};

/**
 * Calculate line weight based on SNR (-20 to +10 dB range typically)
 */
export const getLineWeight = (snr: number | undefined): number => {
  if (snr === undefined) return 3; // default
  // Map SNR from -20..+10 to weight 2..6
  const normalized = Math.max(-20, Math.min(10, snr));
  return 2 + ((normalized + 20) / 30) * 4;
};

/**
 * Create arrow icon for direction indicators
 */
export const createArrowIcon = (angle: number, color: string) => {
  return L.divIcon({
    html: `<div style="transform: rotate(${angle}deg); font-size: 14px; line-height: 1;">
      <span style="color: ${color}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;">▲</span>
    </div>`,
    className: 'traceroute-arrow-icon',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
};

/**
 * Generate arrow markers along a curved path with SNR tooltips
 */
export const generateCurvedArrowMarkers = (
  positions: [number, number][],
  pathKey: string,
  color: string,
  snrs: (number | undefined)[],
  curvature: number,
  normalizeDirection: boolean = true
): React.ReactElement[] => {
  const arrows: React.ReactElement[] = [];

  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i];
    const end = positions[i + 1];
    const snr = snrs[i];

    // Generate the curved path to find the midpoint on the curve
    const curvedPath = generateCurvedPath(start, end, curvature, 20, normalizeDirection);
    const midIdx = Math.floor(curvedPath.length / 2);
    const midPoint = curvedPath[midIdx];

    // Calculate tangent angle at midpoint using adjacent points
    const prevPoint = curvedPath[midIdx - 1] || curvedPath[midIdx];
    const nextPoint = curvedPath[midIdx + 1] || curvedPath[midIdx];
    const latDiff = nextPoint[0] - prevPoint[0];
    const lngDiff = nextPoint[1] - prevPoint[1];
    const angle = Math.atan2(lngDiff, latDiff) * (180 / Math.PI);

    arrows.push(
      <Marker key={`${pathKey}-arrow-${i}`} position={midPoint} icon={createArrowIcon(angle, color)}>
        {snr !== undefined && (
          <Tooltip permanent={false} direction="top" offset={[0, -10]}>
            {snr.toFixed(1)} dB
          </Tooltip>
        )}
      </Marker>
    );
  }

  return arrows;
};

