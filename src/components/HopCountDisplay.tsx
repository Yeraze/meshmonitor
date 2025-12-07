import React from 'react';
import { useTranslation } from 'react-i18next';

interface HopCountDisplayProps {
  hopStart?: number;
  hopLimit?: number;
}

/**
 * Display hop count for mesh messages
 * Shows hop count calculated as (hopStart - hopLimit)
 * Only renders when both values are available and result is valid
 */
const HopCountDisplay: React.FC<HopCountDisplayProps> = ({ hopStart, hopLimit }) => {
  const { t } = useTranslation();

  // Return null if either value is missing
  if (hopStart === undefined || hopLimit === undefined) {
    return null;
  }

  const hopCount = hopStart - hopLimit;

  // Guard against malformed data (negative hop counts)
  if (hopCount < 0) {
    return null;
  }

  return (
    <span style={{ fontSize: '0.75em', marginLeft: '4px', opacity: 0.7 }}>
      ({t('messages.hops', { count: hopCount })})
    </span>
  );
};

export default HopCountDisplay;
