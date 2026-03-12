import React from 'react';
import { useTranslation } from 'react-i18next';
import { getHopColor } from '../utils/mapIcons';
import { useSettings } from '../contexts/SettingsContext';
import { DraggableOverlay } from './DraggableOverlay';
import './MapLegend.css';

interface LegendItem {
  hops: string;
  color: string;
  label: string;
  translate?: boolean;
}

interface LinkLegendItem {
  color: string;
  width: number;
  dashArray?: string;
  opacity: number;
  label: string;
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
  const { overlayColors } = useSettings();

  const legendItems: LegendItem[] = [
    { hops: '0', color: getHopColor(0, overlayColors.hopColors), label: 'map.legend.local', translate: true },
    { hops: '1', color: getHopColor(1, overlayColors.hopColors), label: '1' },
    { hops: '2', color: getHopColor(2, overlayColors.hopColors), label: '2' },
    { hops: '3', color: getHopColor(3, overlayColors.hopColors), label: '3' },
    { hops: '4', color: getHopColor(4, overlayColors.hopColors), label: '4' },
    { hops: '5', color: getHopColor(5, overlayColors.hopColors), label: '5' },
    { hops: '6+', color: getHopColor(6, overlayColors.hopColors), label: '6+' }
  ];

  const linkItems: LinkLegendItem[] = [
    { color: overlayColors.neighborLine, width: 2, opacity: 1, label: t('map.legend.route', 'Route') },
    { color: overlayColors.neighborLine, width: 2, dashArray: '5,5', opacity: 1, label: t('map.legend.neighbor', 'Neighbor') },
    { color: overlayColors.mqttSegment, width: 2, dashArray: '8,8', opacity: 1, label: t('map.legend.mqtt', 'MQTT') },
    { color: overlayColors.tracerouteForward, width: 2, opacity: 1, label: t('map.legend.tracerouteForward', 'Traceroute →') },
    { color: overlayColors.tracerouteReturn, width: 2, dashArray: '5,10', opacity: 1, label: t('map.legend.tracerouteReturn', 'Traceroute ←') },
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
        <div className="legend-divider" />
        <span className="legend-title">{t('map.legend.links', 'Links')}</span>
        {linkItems.map((item, index) => (
          <div key={`link-${index}`} className="legend-item">
            <svg width="24" height="12" className="legend-line-sample">
              <line
                x1="0" y1="6" x2="24" y2="6"
                stroke={item.color}
                strokeWidth={item.width}
                strokeDasharray={item.dashArray || 'none'}
                strokeOpacity={item.opacity}
              />
            </svg>
            <span className="legend-label">{item.label}</span>
          </div>
        ))}
      </div>
    </DraggableOverlay>
  );
};

export default MapLegend;
