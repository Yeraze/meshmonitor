/**
 * Map Features age filter (#3322, #4770, #5344).
 *
 * One component for BOTH Map Features panels (per-source NodesTab and the
 * unified DashboardMap) so their wording cannot drift apart (#5177).
 *
 * The slider can only NARROW the Settings node window (`maxNodeAgeHours`): its
 * top stop follows the setting and reads "All (24h from Settings)", or
 * "All (no limit in Settings)" when the setting is 0 / unset (#4947, #5338).
 * The line under it states what the map currently shows.
 */
import { useTranslation } from 'react-i18next';
import { ageFilterStops, nearestAgeStopIndex } from '../../utils/mapAgeSteps';
import { formatAgeDuration, formatAgeWindow, isUnlimitedAgeWindow } from '../../utils/ageWindow';
import styles from './MapAgeFilterControl.module.css';

interface MapAgeFilterControlProps {
  /** The Settings node window in hours; 0 / negative / non-finite = no limit. */
  maxNodeAgeHours: number;
  /** The effective map window (see effectiveMapMaxAgeHours); Infinity = no limit. */
  effectiveMaxAgeHours: number;
  /** New slider value in hours, or null to follow the Settings window. */
  onChange: (hours: number | null) => void;
}

export default function MapAgeFilterControl({
  maxNodeAgeHours,
  effectiveMaxAgeHours,
  onChange,
}: MapAgeFilterControlProps) {
  const { t } = useTranslation();
  // Keep a "never / show all" setting at 0 so ageFilterStops takes its
  // unlimited branch (top stop = Infinity).
  const settingUnlimited = isUnlimitedAgeWindow(maxNodeAgeHours);
  const maxHours = settingUnlimited ? 0 : Math.max(1, Math.round(maxNodeAgeHours));
  const stops = ageFilterStops(maxHours);
  const topIndex = stops.length - 1;
  const currentIndex = !Number.isFinite(effectiveMaxAgeHours)
    ? topIndex
    : nearestAgeStopIndex(stops, Math.max(1, Math.round(effectiveMaxAgeHours)));

  const allLabel = settingUnlimited
    ? t('map.ageAllUnlimited', { defaultValue: 'All (no limit in Settings)' })
    : t('map.ageAllFromSettings', {
        window: formatAgeDuration(maxHours),
        defaultValue: 'All ({{window}} from Settings)',
      });
  const stopLabel = (idx: number) => (idx >= topIndex ? allLabel : formatAgeWindow(stops[idx], t));
  const current = stopLabel(currentIndex);
  const title = t('map.ageFilter', { defaultValue: 'Map age filter' });

  return (
    <div
      className="map-control-item"
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.25rem' }}
    >
      <span>{title}</span>
      <div className="position-history-slider">
        <input
          type="range"
          min={0}
          max={topIndex}
          step={1}
          value={currentIndex}
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={topIndex}
          aria-valuenow={currentIndex}
          aria-valuetext={current}
          disabled={topIndex < 1}
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            // Top stop == the Settings window → store null so the map follows it.
            onChange(idx >= topIndex ? null : stops[idx]);
          }}
        />
      </div>
      <span className={styles.showing} data-testid="map-age-showing">
        {t('map.ageShowing', { value: current, defaultValue: 'Showing: {{value}}' })}
      </span>
      <span className={styles.hint}>
        {t('map.ageFilterHint', { defaultValue: "Narrows the Settings node window. It can't widen it." })}
      </span>
    </div>
  );
}
