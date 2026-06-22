/**
 * Component to manage marker spiderfier for handling overlapping markers
 * Must be used as a child of MapContainer to access the map instance
 */

import { useImperativeHandle, forwardRef } from 'react';
import { Marker as LeafletMarker } from 'leaflet';
import { OverlappingMarkerSpiderfier, type SpiderfierEventMap, type SpiderfierEventHandler } from 'ts-overlapping-marker-spiderfier-leaflet';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS } from '../hooks/useMarkerSpiderfier';

interface SpiderfierControllerProps {
  /**
   * Current zoom level of the map.
   * Reserved for future zoom-dependent tuning; currently unused but kept so
   * existing callers (NodesTab) don't need to change. Optional so the shared
   * maps (Map Analysis, Dashboard) can mount it without a zoom prop.
   */
  zoomLevel?: number;
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
    const { addMarker, removeMarker, addListener, removeListener, getSpiderfier } =
      useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS);

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
