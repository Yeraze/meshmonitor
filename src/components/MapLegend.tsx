import React from 'react';
import { useTranslation } from 'react-i18next';
import { getHopColor } from '../utils/mapIcons';
import { DraggableOverlay } from './DraggableOverlay';
import './MapLegend.css';

interface LegendItem {
  hops: string;
  color: string;
  label: string;
  translate?: boolean;
}

// Default position: top-right, below the Features checkbox panel, right-aligned with it
// Map container starts at top: 60px (header)
// Features panel is at right: 10px (relative to map), height ~250px when expanded
// Legend is ~100px wide (including drag handle)
const getDefaultPosition = () => ({
  x: window.innerWidth - 100 - 10, // right-align: viewport - legend width - 10px margin (same as Features)
  y: 60 + 10 + 250 + 20 // header + features top + features height + gap = 340
});

const MapLegend: React.FC = () => {
  const { t } = useTranslation();

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
    <DraggableOverlay
      id="map-legend"
      defaultPosition={getDefaultPosition()}
      className="map-legend-wrapper"
    >
      <div className="map-legend">
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
    </DraggableOverlay>
  );
};

export default MapLegend;
