/**
 * "Repeaters only" header chip shared by every Map Features panel (#5891).
 * One component and one MapContext flag, so NodesTab, DashboardMap and
 * MeshCoreMapControls cannot drift apart.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import styles from './MapRepeatersOnlyToggle.module.css';

interface MapRepeatersOnlyToggleProps {
  active: boolean;
  onChange: (value: boolean) => void;
}

export default function MapRepeatersOnlyToggle({ active, onChange }: MapRepeatersOnlyToggleProps) {
  const { t } = useTranslation();
  const title = t('map.repeatersOnlyTitle', 'Show only repeaters and routers');
  return (
    <button
      type="button"
      className={active ? `${styles.toggle} ${styles.active}` : styles.toggle}
      aria-pressed={active}
      aria-label={title}
      title={title}
      onClick={() => onChange(!active)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <UiIcon name="repeater" size={14} />
      {t('map.repeatersOnly', 'Repeaters')}
    </button>
  );
}
