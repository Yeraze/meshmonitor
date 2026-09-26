/**
 * " · last 24h" / " · all" beside a Nodes list count (#5344), so the Settings
 * node window that filters the list is visible without opening Settings.
 * 0 / unset / negative = no cutoff, rendered "all" (#4947, #5338).
 */
import { useTranslation } from 'react-i18next';
import { formatAgeWindow } from '../utils/ageWindow';
import styles from './NodeAgeWindowSuffix.module.css';

interface NodeAgeWindowSuffixProps {
  /** Settings node window in hours (`maxNodeAgeHours`). */
  hours: number | null | undefined;
  /** MeshCore lists age infrastructure nodes on their own window; say so. */
  variant?: 'meshtastic' | 'meshcore';
}

export default function NodeAgeWindowSuffix({ hours, variant = 'meshtastic' }: NodeAgeWindowSuffixProps) {
  const { t } = useTranslation();
  const windowText = formatAgeWindow(hours, t);
  const title = variant === 'meshcore'
    ? t('nodes.window_title_meshcore', {
        window: windowText,
        defaultValue: 'The Nodes list shows companions heard in this window ({{window}}). Repeaters and room servers use their own window. Change both in Settings > Node Display.',
      })
    : t('nodes.window_title', {
        window: windowText,
        defaultValue: 'The Nodes list shows nodes heard in this window ({{window}}). Change it in Settings > Node Display.',
      });
  return (
    <span className={styles.suffix} title={title} data-testid="node-age-window">
      {' · '}{windowText}
    </span>
  );
}
