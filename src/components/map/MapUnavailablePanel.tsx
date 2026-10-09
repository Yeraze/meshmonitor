import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import { describeError } from '../common/describeError';
import styles from './MapUnavailablePanel.module.css';

export interface MapUnavailablePanelProps {
  /** Whatever the map threw. */
  error: unknown;
  /** Re-render the map. */
  onRetry: () => void;
}

/**
 * Shown in a map's place when something inside `BaseMap` throws. Fills the
 * box the map had, so the page layout around it does not move.
 */
export function MapUnavailablePanel({ error, onRetry }: MapUnavailablePanelProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.panel} role="alert" data-testid="map-unavailable">
      <span className={styles.icon} aria-hidden="true">
        <UiIcon name="alert" size={24} />
      </span>
      <strong className={styles.title}>{t('map.unavailable_title', 'Map unavailable')}</strong>
      <span className={styles.body}>
        {t('map.unavailable_body', 'The map could not be drawn. The rest of the page still works.')}
      </span>
      {error != null && (
        <details className={styles.details}>
          <summary>{t('map.unavailable_details', 'Error details')}</summary>
          <pre>{describeError(error)}</pre>
        </details>
      )}
      <button type="button" className={styles.retry} onClick={onRetry}>
        {t('map.unavailable_retry', 'Try again')}
      </button>
    </div>
  );
}

export default MapUnavailablePanel;
