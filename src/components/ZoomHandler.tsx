import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';

interface ZoomHandlerProps {
  onZoomChange: (zoom: number) => void;
}

const ZoomHandler: React.FC<ZoomHandlerProps> = ({ onZoomChange }) => {
  const map = useMap();

  useEffect(() => {
    const handleZoom = () => {
      onZoomChange(map.getZoom());
    };

    // Set initial zoom
    onZoomChange(map.getZoom());

    map.on('zoomend', handleZoom);
    return () => {
      map.off('zoomend', handleZoom);
    };
  }, [map, onZoomChange]);

  return null;
};

export default ZoomHandler;
