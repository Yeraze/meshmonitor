import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getHopColor } from '../utils/mapIcons';
import { useSettings, TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
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

export interface PositionHistoryData {
  oldestTime: number;
  newestTime: number;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

interface MapLegendProps {
  positionHistory?: PositionHistoryData;
}

// Default position: top-right, below the Features checkbox panel, right-aligned with it
// Map container starts at top: 60px (header)
// Features panel is at right: 10px (relative to map), height ~250px when expanded
const getDefaultPosition = () => ({
  x: window.innerWidth - 200 - 10, // right-align with FEATURES panel (right: 10px)
  y: 60 + 10 + 250 + 20 // header + features top + features height + gap = 340
});

const MapLegend: React.FC<MapLegendProps> = ({ positionHistory }) => {
  const { t } = useTranslation();
  const { overlayColors } = useSettings();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    const stored = localStorage.getItem('mapLegendCollapsed');
    return stored !== null ? stored === 'true' : false; // expanded by default
  });

  const handleToggleCollapse = () => {
    const newValue = !isCollapsed;
    setIsCollapsed(newValue);
    localStorage.setItem('mapLegendCollapsed', String(newValue));
  };

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
    { color: overlayColors.mqttSegment, width: 2, dashArray: '3,6', opacity: 1, label: t('map.legend.mqtt', 'MQTT') },
    { color: overlayColors.tracerouteForward, width: 2, opacity: 1, label: t('map.legend.tracerouteForward', 'Traceroute →') },
    { color: overlayColors.tracerouteReturn, width: 2, dashArray: '5,10', opacity: 1, label: t('map.legend.tracerouteReturn', 'Traceroute ←') },
  ];

  const formatTime = (timestamp: number) => {
    if (!positionHistory) return '';
    return formatDateTime(new Date(timestamp), positionHistory.timeFormat, positionHistory.dateFormat);
  };

  return (
    <DraggableOverlay
      id="map-legend"
      defaultPosition={getDefaultPosition()}
      className="map-legend-wrapper"
    >
      <div className={`map-legend ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="legend-header">
          <span className="legend-title">{t('map.legend.hops')}</span>
          <button
            className="legend-collapse-btn"
            onClick={handleToggleCollapse}
            onMouseDown={(e) => e.stopPropagation()}
            title={isCollapsed ? 'Expand legend' : 'Collapse legend'}
          >
            {isCollapsed ? '▼' : '▲'}
          </button>
        </div>
        {!isCollapsed && (
          <>
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
            <div className="legend-divider" />
            <span className="legend-title">{t('map.legend.snrQuality', 'SNR Quality')}</span>
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: overlayColors.snrColors.good }} />
              <span className="legend-label">{t('map.legend.snrGood', 'Good (> 0 dB)')}</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: overlayColors.snrColors.medium }} />
              <span className="legend-label">{t('map.legend.snrMedium', 'Medium')}</span>
            </div>
            <div className="legend-item">
              <div className="legend-dot" style={{ backgroundColor: overlayColors.snrColors.poor }} />
              <span className="legend-label">{t('map.legend.snrPoor', 'Poor (< -10 dB)')}</span>
            </div>
            {positionHistory && (
              <>
                <div className="legend-divider" />
                <span className="legend-title">{t('map.legend.positionHistory')}</span>
                <div className="legend-gradient-container">
                  <div className="legend-gradient-bar" />
                  <div className="legend-gradient-labels">
                    <span className="legend-gradient-label oldest">{t('map.legend.oldest')}</span>
                    <span className="legend-gradient-label newest">{t('map.legend.newest')}</span>
                  </div>
                </div>
                <div className="legend-time-labels">
                  <span className="legend-time-label">{formatTime(positionHistory.oldestTime)}</span>
                  <span className="legend-time-label">{formatTime(positionHistory.newestTime)}</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </DraggableOverlay>
  );
};

export default MapLegend;
