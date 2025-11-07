import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';

interface MapResizeHandlerProps {
  trigger: boolean;
}

const MapResizeHandler: React.FC<MapResizeHandlerProps> = ({ trigger }) => {
  const map = useMap();

  useEffect(() => {
    // Delay to allow CSS transitions to complete
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 300);

    return () => clearTimeout(timer);
  }, [trigger, map]);

  return null;
};

export default MapResizeHandler;
