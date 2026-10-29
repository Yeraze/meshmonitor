import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { useMapViewStore } from '../contexts/mapViewStore';

/**
 * Component that tracks map center changes and records them in the map view
 * store (which persists them). It writes without subscribing, so a pan
 * re-renders nothing.
 */
const MapPositionHandler = () => {
  const map = useMap();
  const { setCenter: setMapCenter } = useMapViewStore();

  useEffect(() => {
    const handleMoveEnd = () => {
      const center = map.getCenter();
      setMapCenter([center.lat, center.lng]);
    };

    // Set initial center
    handleMoveEnd();

    // Listen for map move events
    map.on('moveend', handleMoveEnd);

    return () => {
      map.off('moveend', handleMoveEnd);
    };
  }, [map, setMapCenter]);

  return null;
};

export default MapPositionHandler;
