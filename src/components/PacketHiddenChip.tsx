import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './PacketHiddenChip.module.css';

interface PacketHiddenChipProps {
  /** Loaded rows the client-side "Hide Own Packets" filter removed */
  count: number;
  /** Called when the chip is clicked (the panel opens the filter drawer) */
  onClick?: () => void;
}

/**
 * Says how many loaded rows the client filter is hiding (#5579). The filter
 * checkbox sits in a collapsed drawer, so without this a user has no sign that
 * rows are missing. Renders nothing when no rows are hidden.
 */
const PacketHiddenChip: React.FC<PacketHiddenChipProps> = ({ count, onClick }) => {
  const { t } = useTranslation();
  if (!(count > 0)) return null;

  const tooltip = t('packet_monitor.hidden_tooltip', { count });
  return (
    <button
      type="button"
      className={styles.chip}
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      data-testid="packet-hidden-chip"
    >
      <UiIcon name="visibilityOff" size={12} />
      <span>{t('packet_monitor.hidden_count', { count })}</span>
    </button>
  );
};

export default PacketHiddenChip;
