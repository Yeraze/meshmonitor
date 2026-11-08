import React, { useEffect } from 'react';
import type L from 'leaflet';
import { useMap } from 'react-leaflet';

/**
 * Hands the Leaflet map instance out of BaseMap (#5354 Phase 3). The asset
 * playback bar is a sibling of the map (so it can sit over it as a DOM
 * overlay) but moves its marker imperatively on the map.
 */
export const MapInstanceBridge: React.FC<{ onMap: (map: L.Map | null) => void }> = ({ onMap }) => {
  const map = useMap();
  useEffect(() => {
    onMap(map);
    return () => onMap(null);
  }, [map, onMap]);
  return null;
};

export default MapInstanceBridge;
