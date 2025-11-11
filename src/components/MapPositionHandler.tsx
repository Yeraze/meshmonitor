import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { useMapContext } from '../contexts/MapContext';

/**
 * Component that tracks map center changes and updates context
 */
const MapPositionHandler = () => {
  const map = useMap();
  const { setMapCenter } = useMapContext();

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
