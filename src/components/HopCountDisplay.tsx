import React from 'react';
import { useTranslation } from 'react-i18next';

interface HopCountDisplayProps {
  hopStart?: number;
  hopLimit?: number;
  rxSnr?: number;
  rxRssi?: number;
}

/**
 * Display hop count for mesh messages
 * Shows hop count calculated as (hopStart - hopLimit)
 * For direct messages (0 hops), shows SNR/RSSI instead if available
 * Only renders when both hop values are available and result is valid
 */
const HopCountDisplay: React.FC<HopCountDisplayProps> = ({ hopStart, hopLimit, rxSnr, rxRssi }) => {
  const { t } = useTranslation();

  // Return null if either hop value is missing
  if (hopStart === undefined || hopLimit === undefined) {
    return null;
  }

  const hopCount = hopStart - hopLimit;

  // Guard against malformed data (negative hop counts)
  if (hopCount < 0) {
    return null;
  }

  // For direct messages (0 hops), show SNR/RSSI if available
  if (hopCount === 0 && (rxSnr != null || rxRssi != null)) {
    const parts: string[] = [];
    if (rxSnr != null) {
      parts.push(`${rxSnr.toFixed(1)} dB`);
    }
    if (rxRssi != null) {
      parts.push(`${rxRssi} dBm`);
    }
    return (
      <span style={{ fontSize: '0.75em', marginLeft: '4px', opacity: 0.7 }} title={t('messages.signal_info')}>
        ({parts.join(' / ')})
      </span>
    );
  }

  return (
    <span style={{ fontSize: '0.75em', marginLeft: '4px', opacity: 0.7 }}>
      ({t('messages.hops', { count: hopCount })})
    </span>
  );
};

export default HopCountDisplay;
