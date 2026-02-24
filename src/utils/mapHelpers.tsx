import React from 'react';
import L from 'leaflet';
import { Marker, Tooltip, Popup } from 'react-leaflet';
import { PositionHistoryItem } from '../contexts/MapContext';

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

// Position history color gradient constants
const POSITION_HISTORY_COLOR_OLD = { r: 0, g: 191, b: 255 };   // Cyan-blue (#00bfff)
const POSITION_HISTORY_COLOR_NEW = { r: 255, g: 69, b: 0 };    // Orange-red (#ff4500)

/**
 * Linear interpolation between two RGB colors
 * @param colorA Starting color {r, g, b}
 * @param colorB Ending color {r, g, b}
 * @param ratio Interpolation ratio (0 = colorA, 1 = colorB)
 * @returns Interpolated color as hex string
 */
export const interpolateColor = (
  colorA: { r: number; g: number; b: number },
  colorB: { r: number; g: number; b: number },
  ratio: number
): string => {
  const r = Math.round(colorA.r + (colorB.r - colorA.r) * ratio);
  const g = Math.round(colorA.g + (colorB.g - colorA.g) * ratio);
  const b = Math.round(colorA.b + (colorB.b - colorA.b) * ratio);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
};

/**
 * Get color for a position history segment based on age
 * @param index Segment index (0 = oldest)
 * @param total Total number of segments
 * @returns Hex color string
 */
export const getPositionHistoryColor = (index: number, total: number): string => {
  if (total <= 1) return interpolateColor(POSITION_HISTORY_COLOR_OLD, POSITION_HISTORY_COLOR_NEW, 1);
  const ratio = index / (total - 1);
  return interpolateColor(POSITION_HISTORY_COLOR_OLD, POSITION_HISTORY_COLOR_NEW, ratio);
};

/**
 * Generate curved path using actual heading data for accurate trajectory representation
 * Uses heading to determine control point direction for more realistic path curves
 *
 * @param start Starting position [lat, lng]
 * @param end Ending position [lat, lng]
 * @param heading Ground track in degrees (0 = North, clockwise)
 * @param speed Ground speed in m/s (affects control point distance)
 * @param segments Number of segments to generate (default 10 for position history)
 * @returns Array of [lat, lng] points forming the curved path
 */
export const generateHeadingAwarePath = (
  start: [number, number],
  end: [number, number],
  heading?: number,
  speed?: number,
  segments: number = 10
): [number, number][] => {
  // If no heading data, fall back to straight line
  if (heading === undefined) {
    return [start, end];
  }

  const points: [number, number][] = [];

  // Calculate direct distance between points
  const dx = end[1] - start[1];
  const dy = end[0] - start[0];
  const directDistance = Math.sqrt(dx * dx + dy * dy);

  if (directDistance === 0) return [start, end];

  // Data is stored in millidegrees (1/1000 degree) - detect and convert
  let headingDegrees = heading;
  if (headingDegrees > 360) {
    headingDegrees = headingDegrees / 1000;
  }

  // Convert heading from degrees to radians (0 = North, clockwise)
  // Geographic heading: 0 = North, 90 = East, 180 = South, 270 = West
  // We need to convert to math angle where 0 = East, counter-clockwise
  const headingRad = (90 - headingDegrees) * Math.PI / 180;

  // Control point distance based on speed (faster = more lookahead)
  // Default to 20% of direct distance, scale up with speed
  const speedFactor = speed !== undefined ? Math.min(speed / 10, 2) : 1;
  const controlDistance = directDistance * 0.3 * speedFactor;

  // Calculate control point position based on heading from start point
  const ctrlLat = start[0] + Math.sin(headingRad) * controlDistance;
  const ctrlLng = start[1] + Math.cos(headingRad) * controlDistance;

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
 * Format a compass heading to cardinal direction
 */
const getCardinalDirection = (heading: number): string => {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(heading / 22.5) % 16;
  return directions[index];
};

/**
 * Generate position history arrow markers with limited count for performance
 * Places arrow at each position point, rotated to match groundTrack (heading)
 * @param historyItems Array of position history items with full data
 * @param colors Array of colors for each position
 * @param maxArrows Maximum number of arrows to generate
 * @param distanceUnit User's preferred distance unit ('km' or 'mi')
 * @returns Array of Marker components with clickable popups
 */
export const generatePositionHistoryArrows = (
  historyItems: PositionHistoryItem[],
  colors: string[],
  maxArrows: number = 30,
  distanceUnit: 'km' | 'mi' = 'km'
): React.ReactElement[] => {
  const arrows: React.ReactElement[] = [];
  const itemCount = historyItems.length;

  if (itemCount <= 0) return arrows;

  // Calculate how many items to skip to stay under maxArrows
  const step = Math.max(1, Math.ceil(itemCount / maxArrows));

  for (let i = 0; i < itemCount && arrows.length < maxArrows; i += step) {
    const item = historyItems[i];
    // Safely get color - default to blue if colors array is empty
    const color = colors.length > 0 ? colors[Math.min(i, colors.length - 1)] : '#3b82f6';

    // Use groundTrack if available, otherwise calculate from next position
    let angle: number;
    if (item.groundTrack !== undefined) {
      // groundTrack should be in degrees (0=North, 90=East)
      // But data is stored in millidegrees (1/1000 degree) - detect and convert
      let heading = item.groundTrack;
      if (heading > 360) {
        // Value is in millidegrees, convert to degrees
        heading = heading / 1000;
      }
      angle = heading;
    } else if (i < itemCount - 1) {
      // Calculate angle from this position to next
      const next = historyItems[i + 1];
      const latDiff = next.latitude - item.latitude;
      const lngDiff = next.longitude - item.longitude;
      // atan2 returns radians with 0 = East, we need 0 = North
      angle = (Math.atan2(lngDiff, latDiff) * 180 / Math.PI);
    } else {
      // Last point with no heading data - skip arrow
      continue;
    }

    const arrowIcon = L.divIcon({
      html: `<div style="transform: rotate(${angle}deg); font-size: 16px; font-weight: bold; cursor: pointer;">
        <span style="color: ${color}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;">▲</span>
      </div>`,
      className: 'position-history-arrow-icon',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });

    // Format date and time
    const date = new Date(item.timestamp);
    const dateStr = date.toLocaleDateString();
    const timeStr = date.toLocaleTimeString();

    // Format speed (convert from m/s to km/h, then to mph if needed)
    // Some devices may report in different units - sanity check for reasonable values
    let speedDisplay: string | null = null;
    let speedUnit = distanceUnit === 'mi' ? 'mph' : 'km/h';
    if (item.groundSpeed !== undefined) {
      const converted = item.groundSpeed * 3.6;
      // If converted speed > 200 km/h, assume raw value is already in km/h
      const speedKmh = converted > 200 ? item.groundSpeed : converted;
      // Convert to mph if user prefers miles
      const speed = distanceUnit === 'mi' ? speedKmh * 0.621371 : speedKmh;
      speedDisplay = speed.toFixed(1);
    }

    // Format heading
    // Data is stored in millidegrees (1/1000 degree) - detect and convert
    let headingStr: string | null = null;
    if (item.groundTrack !== undefined) {
      let heading = item.groundTrack;
      if (heading > 360) {
        heading = heading / 1000;
      }
      headingStr = `${heading.toFixed(0)}° ${getCardinalDirection(heading)}`;
    }

    arrows.push(
      <Marker
        key={`position-history-arrow-${i}`}
        position={[item.latitude, item.longitude]}
        icon={arrowIcon}
      >
        <Popup>
          <div className="position-history-popup">
            <div><strong>Date:</strong> {dateStr}</div>
            <div><strong>Time:</strong> {timeStr}</div>
            {speedDisplay !== null && (
              <div><strong>Speed:</strong> {speedDisplay} {speedUnit}</div>
            )}
            {headingStr !== null && (
              <div><strong>Heading:</strong> {headingStr}</div>
            )}
            {item.altitude !== undefined && (
              <div><strong>Altitude:</strong> {item.altitude} m</div>
            )}
          </div>
        </Popup>
      </Marker>
    );
  }

  return arrows;
};

