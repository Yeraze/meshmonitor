/**
 * Map Features "Likely aircraft" display control (#5364/#5365 Phase 1 WP4).
 *
 * One component for BOTH Map Features panels (per-source NodesTab and the
 * unified DashboardMap) so their wording cannot drift apart, following the
 * `MapAgeFilterControl` precedent (#5177 shipped a toggle to only one panel
 * with a fully green suite — memory: "TWO Map Features panels").
 *
 * Three modes:
 *  - 'show'  — no badge, no filtering (aircraft render like any other node).
 *  - 'mark'  — badge on the marker (default).
 *  - 'hide'  — marker suppressed, EXCEPT for favourites (a user's own
 *              favourite is never hidden by this toggle).
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { AircraftDisplayMode } from '../../utils/aircraftClassification';
import { AIRCRAFT_DISPLAY_MODES } from '../../utils/aircraftClassification';
import styles from './MapAircraftDisplayControl.module.css';

interface MapAircraftDisplayControlProps {
  mode: AircraftDisplayMode;
  onChange: (mode: AircraftDisplayMode) => void;
  /** Count of likely-aircraft nodes in the current (pre-hide) set, for the hint line. */
  aircraftCount?: number;
}

export default function MapAircraftDisplayControl({
  mode,
  onChange,
  aircraftCount,
}: MapAircraftDisplayControlProps) {
  const { t } = useTranslation();
  const title = t('map.aircraftDisplay', { defaultValue: 'Likely aircraft' });
  const modeLabel = (m: AircraftDisplayMode): string => {
    switch (m) {
      case 'show':
        return t('map.aircraftShow', { defaultValue: 'Show' });
      case 'hide':
        return t('map.aircraftHide', { defaultValue: 'Hide' });
      case 'mark':
      default:
        return t('map.aircraftMark', { defaultValue: 'Mark' });
    }
  };

  return (
    <div className={`map-control-item ${styles.control}`} data-testid="map-aircraft-mode">
      <span>
        <UiIcon name="aircraft" size={15} /> {title}
      </span>
      <div role="radiogroup" aria-label={title} className={styles.radios}>
        {AIRCRAFT_DISPLAY_MODES.map((m) => (
          <label key={m} className={styles.radioOption}>
            <input
              type="radio"
              name="aircraft-display-mode"
              value={m}
              checked={mode === m}
              onChange={() => onChange(m)}
            />
            <span>{modeLabel(m)}</span>
          </label>
        ))}
      </div>
      <span className={styles.hint}>
        {t('map.aircraftHint', {
          defaultValue: "Flagged when a node is more than the source's threshold above the terrain.",
        })}
        {aircraftCount != null
          ? ` ${t('map.aircraftCount', { count: aircraftCount, defaultValue: '{{count}} on the map.' })}`
          : ''}
      </span>
    </div>
  );
}
