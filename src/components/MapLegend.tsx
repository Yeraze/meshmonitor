import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useMap } from 'react-leaflet';
import { getHopColor } from '../utils/mapIcons';
import './MapLegend.css';

interface LegendItem {
  hops: string;
  color: string;
  label: string;
  translate?: boolean;
}

const MapLegend: React.FC = () => {
  const { t } = useTranslation();
  const map = useMap();

  // Position state with localStorage persistence
  const [position, setPosition] = useState(() => {
    const saved = localStorage.getItem('mapLegendPosition');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return { x: parsed.x ?? 10, y: parsed.y ?? 10 };
      } catch {
        return { x: 10, y: 10 };
      }
    }
    return { x: 10, y: 10 };
  });

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const legendRef = useRef<HTMLDivElement>(null);

  // Save position to localStorage
  useEffect(() => {
    localStorage.setItem('mapLegendPosition', JSON.stringify(position));
  }, [position]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent map panning
    
    // Disable Leaflet map dragging
    if (map) {
      map.dragging.disable();
    }
    
    const mapContainer = document.querySelector('.map-container');
    if (!mapContainer) return;
    
    const rect = mapContainer.getBoundingClientRect();
    const legend = legendRef.current;
    if (!legend) return;
    
    // Calculate the initial mouse position relative to the map container
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Calculate the offset from the legend's current position
    setIsDragging(true);
    setDragStart({
      x: mouseX - position.x,
      y: mouseY - position.y,
    });
  }, [position, map]);

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    
    e.preventDefault();
    e.stopPropagation(); // Prevent map panning
    
    const mapContainer = document.querySelector('.map-container');
    if (!mapContainer) return;
    
    const rect = mapContainer.getBoundingClientRect();
    const legend = legendRef.current;
    if (!legend) return;
    
    const legendRect = legend.getBoundingClientRect();
    const maxX = rect.width - legendRect.width - 10;
    const maxY = rect.height - legendRect.height - 10;
    
    // Calculate new position relative to map container
    const newX = Math.max(10, Math.min(maxX, e.clientX - dragStart.x - rect.left));
    const newY = Math.max(10, Math.min(maxY, e.clientY - dragStart.y - rect.top));
    
    setPosition({ x: newX, y: newY });
  }, [isDragging, dragStart]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    
    // Re-enable Leaflet map dragging
    if (map) {
      map.dragging.enable();
    }
  }, [map]);

  // Global mouse event listeners for drag
  useEffect(() => {
    if (isDragging) {
      // Disable map dragging when we start dragging
      if (map) {
        map.dragging.disable();
      }
      
      document.addEventListener('mousemove', handleDragMove, { passive: false });
      document.addEventListener('mouseup', handleDragEnd);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      
      return () => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Re-enable map dragging when done
        if (map) {
          map.dragging.enable();
        }
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd, map]);

  const legendItems: LegendItem[] = [
    { hops: '0', color: getHopColor(0), label: 'map.legend.local', translate: true },
    { hops: '1', color: getHopColor(1), label: '1' },
    { hops: '2', color: getHopColor(2), label: '2' },
    { hops: '3', color: getHopColor(3), label: '3' },
    { hops: '4', color: getHopColor(4), label: '4' },
    { hops: '5', color: getHopColor(5), label: '5' },
    { hops: '6+', color: getHopColor(6), label: '6+' }
  ];

  return (
    <div
      ref={legendRef}
      className="map-legend"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        right: 'auto',
        cursor: isDragging ? 'grabbing' : 'grab',
      }}
      onMouseDown={handleDragStart}
      onDragStart={(e) => e.preventDefault()} // Prevent default drag behavior
      onClick={(e) => e.stopPropagation()} // Prevent map clicks
    >
      <span className="legend-title">{t('map.legend.hops')}</span>
      {legendItems.map((item, index) => (
        <div key={index} className="legend-item">
          <div
            className="legend-dot"
            style={{ backgroundColor: item.color }}
          />
          <span className="legend-label">{item.translate ? t(item.label) : item.label}</span>
        </div>
      ))}
    </div>
  );
};

export default MapLegend;
