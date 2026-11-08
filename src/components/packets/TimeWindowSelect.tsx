/**
 * Time-window select for packet monitors (#6262): 1h/6h/24h/7d/all.
 * Emits a `since` epoch-ms (or undefined for "all") — the value the packet
 * APIs take.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TimeWindowKey } from './timeWindow';

export interface TimeWindowSelectProps {
  value: TimeWindowKey;
  onChange: (key: TimeWindowKey) => void;
  className?: string;
}

const TimeWindowSelect: React.FC<TimeWindowSelectProps> = ({ value, onChange, className }) => {
  const { t } = useTranslation();
  return (
    <select
      className={className}
      value={value}
      onChange={e => onChange(e.target.value as TimeWindowKey)}
      aria-label={t('packets.timeWindow.label', 'Time window')}
    >
      <option value="1h">{t('packets.timeWindow.1h', 'Last hour')}</option>
      <option value="6h">{t('packets.timeWindow.6h', 'Last 6 hours')}</option>
      <option value="24h">{t('packets.timeWindow.24h', 'Last 24 hours')}</option>
      <option value="7d">{t('packets.timeWindow.7d', 'Last 7 days')}</option>
      <option value="all">{t('packets.timeWindow.all', 'All time')}</option>
    </select>
  );
};

export default TimeWindowSelect;
