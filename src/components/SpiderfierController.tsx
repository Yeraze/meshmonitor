/**
 * Component to manage marker spiderfier for handling overlapping markers
 * Must be used as a child of MapContainer to access the map instance
 */

import { useImperativeHandle, forwardRef } from 'react';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';
import { useMarkerSpiderfier } from '../hooks/useMarkerSpiderfier';

/**
 * Spiderfier configuration constants
 */
const SPIDERFIER_CONFIG = {
  /** Pixel radius for detecting overlapping markers - 50px catches markers at same GPS coords */
  NEARBY_DISTANCE: 50,
  /** Number of markers before switching from circle to spiral layout */
  CIRCLE_SPIRAL_SWITCHOVER: 9,
  /** Distance between markers in circle layout (pixels) - increased for better separation */
  CIRCLE_FOOT_SEPARATION: 50,
  /** Distance between markers in spiral layout (pixels) - increased for better separation */
  SPIRAL_FOOT_SEPARATION: 50,
  /** Starting radius for spiral layout (pixels) - larger start for better spacing */
  SPIRAL_LENGTH_START: 20,
  /** How quickly spiral grows - higher = faster growth and more spacing */
  SPIRAL_LENGTH_FACTOR: 8,
  /** Line thickness for spider legs */
  LEG_WEIGHT: 2,
} as const;

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
    const { addMarker, removeMarker, addListener, removeListener, getSpiderfier } = useMarkerSpiderfier({
      keepSpiderfied: true, // Keep markers fanned out after clicking
      nearbyDistance: SPIDERFIER_CONFIG.NEARBY_DISTANCE,
      circleSpiralSwitchover: SPIDERFIER_CONFIG.CIRCLE_SPIRAL_SWITCHOVER,
      circleFootSeparation: SPIDERFIER_CONFIG.CIRCLE_FOOT_SEPARATION,
      spiralFootSeparation: SPIDERFIER_CONFIG.SPIRAL_FOOT_SEPARATION,
      spiralLengthStart: SPIDERFIER_CONFIG.SPIRAL_LENGTH_START,
      spiralLengthFactor: SPIDERFIER_CONFIG.SPIRAL_LENGTH_FACTOR,
      legWeight: SPIDERFIER_CONFIG.LEG_WEIGHT,
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
