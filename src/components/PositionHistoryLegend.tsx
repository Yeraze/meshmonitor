import React from 'react';
import { useTranslation } from 'react-i18next';
import { DraggableOverlay } from './DraggableOverlay';
import { formatDateTime } from '../utils/datetime';
import { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import './PositionHistoryLegend.css';

interface PositionHistoryLegendProps {
  oldestTime: number;
  newestTime: number;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
}

// Default position: below the hop count legend
// Map container starts at top: 60px (header)
// Features panel is at right: 10px, height ~250px
// Hop legend is at y: 340, height ~120px
// Position history legend goes below it
const getDefaultPosition = () => ({
  x: window.innerWidth - 140 - 10, // right-align: viewport - legend width - margin
  y: 60 + 10 + 250 + 20 + 130 + 10 // header + features + gap + hop legend + gap
});

const PositionHistoryLegend: React.FC<PositionHistoryLegendProps> = ({
  oldestTime,
  newestTime,
  timeFormat,
  dateFormat
}) => {
  const { t } = useTranslation();

  const formatTime = (timestamp: number) => {
    return formatDateTime(new Date(timestamp), timeFormat, dateFormat);
  };

  return (
    <DraggableOverlay
      id="position-history-legend"
      defaultPosition={getDefaultPosition()}
      className="position-history-legend-wrapper"
    >
      <div className="position-history-legend">
        <span className="legend-title">{t('map.legend.positionHistory')}</span>
        <div className="gradient-container">
          <div className="gradient-bar" />
          <div className="gradient-labels">
            <span className="gradient-label oldest">{t('map.legend.oldest')}</span>
            <span className="gradient-label newest">{t('map.legend.newest')}</span>
          </div>
        </div>
        <div className="time-labels">
          <span className="time-label">{formatTime(oldestTime)}</span>
          <span className="time-label">{formatTime(newestTime)}</span>
        </div>
      </div>
    </DraggableOverlay>
  );
};

export default PositionHistoryLegend;
