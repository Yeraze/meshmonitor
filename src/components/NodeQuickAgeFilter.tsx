/**
 * Nodes tab quick age filter (#5387): a compact " · [last 24h ▾]" picker beside
 * the Nodes list count. Replaces the read-only #5344 suffix, which only showed
 * the Settings window.
 *
 * View-only: picking a window changes what this viewer's Nodes list and map
 * show, never the saved `maxNodeAgeHours`. "Setting" restores the Settings
 * window. See src/utils/nodeQuickAgeFilter.ts for the semantics.
 */
import { useTranslation } from 'react-i18next';
import { formatAgeWindow } from '../utils/ageWindow';
import { NODE_QUICK_AGE_OPTIONS } from '../utils/nodeQuickAgeFilter';
import { useNodeQuickAgeFilter } from '../hooks/useNodeQuickAgeFilter';
import styles from './NodeQuickAgeFilter.module.css';

interface NodeQuickAgeFilterProps {
  /** Settings node window in hours (`maxNodeAgeHours`); 0 / unset = all. */
  settingsHours: number | null | undefined;
  /** MeshCore lists age infrastructure nodes on their own window; say so. */
  variant?: 'meshtastic' | 'meshcore';
}

const SETTING_VALUE = 'setting';

export default function NodeQuickAgeFilter({ settingsHours, variant = 'meshtastic' }: NodeQuickAgeFilterProps) {
  const { t } = useTranslation();
  const [quickHours, setQuickHours] = useNodeQuickAgeFilter();
  const settingWindow = formatAgeWindow(settingsHours, t);
  const overridden = quickHours != null;

  let title: string;
  if (overridden) {
    title = variant === 'meshcore'
      ? t('nodes.quick_age.title_override_meshcore', {
          window: formatAgeWindow(quickHours, t),
          setting: settingWindow,
          defaultValue: 'This view shows companions, repeaters, and room servers heard in this window ({{window}}). Only you see this, and both node window settings are unchanged. Pick "Setting" to go back.',
        })
      : t('nodes.quick_age.title_override', {
          window: formatAgeWindow(quickHours, t),
          setting: settingWindow,
          defaultValue: 'This view shows nodes heard in this window ({{window}}). Only you see this, and your setting ({{setting}}) is unchanged. Pick "Setting" to go back.',
        });
  } else {
    title = variant === 'meshcore'
      ? t('nodes.window_title_meshcore', {
          window: settingWindow,
          defaultValue: 'The Nodes list shows companions heard in this window ({{window}}). Repeaters and room servers use their own window. Change both in Settings > Node Display.',
        })
      : t('nodes.window_title', {
          window: settingWindow,
          defaultValue: 'The Nodes list shows nodes heard in this window ({{window}}). Change it in Settings > Node Display.',
        });
  }

  const label = t('nodes.quick_age.label', { defaultValue: 'Node age window' });

  return (
    <span className={styles.wrap} data-testid="node-age-window">
      <span className={styles.sep} aria-hidden="true">·</span>
      <select
        className={`${styles.select} ${overridden ? styles.overridden : ''}`}
        value={overridden ? String(quickHours) : SETTING_VALUE}
        onChange={(e) => {
          const v = e.target.value;
          setQuickHours(v === SETTING_VALUE ? null : Number(v));
        }}
        aria-label={label}
        title={title}
      >
        <option value={SETTING_VALUE}>
          {t('nodes.quick_age.setting', { window: settingWindow, defaultValue: 'Setting ({{window}})' })}
        </option>
        {NODE_QUICK_AGE_OPTIONS.map((h) => (
          <option key={h} value={String(h)}>
            {formatAgeWindow(h, t)}
          </option>
        ))}
      </select>
    </span>
  );
}
