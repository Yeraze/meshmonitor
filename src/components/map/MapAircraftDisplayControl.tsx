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
 *
 * Phase 2 adds a "Show aged-out" checkbox: aircraft the age-out sweep ignored
 * are drawn dimmed, with the badge, even in 'show' or 'hide' mode.
 *
 * Phase 3 adds a "Flight trails" checkbox and, while it is on, a lookback
 * slider (1..168 h). Both are saved per user on the server.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { AircraftDisplayMode } from '../../utils/aircraftClassification';
import { AIRCRAFT_DISPLAY_MODES } from '../../utils/aircraftClassification';
import { formatAgeDuration } from '../../utils/ageWindow';
import { AIRCRAFT_TRAIL_HOUR_STOPS, nearestTrailHourStopIndex } from './aircraftTrailStops';
import styles from './MapAircraftDisplayControl.module.css';

/** Slider moves settle for this long before the value is saved and refetched. */
const TRAIL_HOURS_COMMIT_MS = 400;

interface MapAircraftDisplayControlProps {
  mode: AircraftDisplayMode;
  onChange: (mode: AircraftDisplayMode) => void;
  /** Count of likely-aircraft nodes in the current (pre-hide) set, for the hint line. */
  aircraftCount?: number;
  /**
   * "Show aged-out" checkbox (#5364/#5365 Phase 2). Rendered only when
   * `onShowAgedOutChange` is given. When on, likely aircraft the age-out sweep
   * ignored are drawn dimmed despite the ignored filter.
   */
  showAgedOut?: boolean;
  onShowAgedOutChange?: (value: boolean) => void;
  /** Aged-out aircraft the map would draw with the checkbox on (same filtered set). */
  agedOutCount?: number;
  /**
   * "Flight trails" checkbox (#5364/#5365 Phase 3). Rendered only when
   * `onShowTrailsChange` is given; the lookback slider shows only while on.
   */
  showTrails?: boolean;
  onShowTrailsChange?: (value: boolean) => void;
  /** Lookback in hours, 1..168. */
  trailHours?: number;
  onTrailHoursChange?: (hours: number) => void;
}

export default function MapAircraftDisplayControl({
  mode,
  onChange,
  aircraftCount,
  showAgedOut = false,
  onShowAgedOutChange,
  agedOutCount,
  showTrails = false,
  onShowTrailsChange,
  trailHours = 6,
  onTrailHoursChange,
}: MapAircraftDisplayControlProps) {
  const { t } = useTranslation();
  // The slider moves a local draft; the saved value (a server POST plus a
  // trail refetch) follows once the thumb has settled.
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
  }, []);
  const savedIndex = nearestTrailHourStopIndex(trailHours);
  const sliderIndex = draftIndex ?? savedIndex;
  const trailHoursLabel = formatAgeDuration(AIRCRAFT_TRAIL_HOUR_STOPS[sliderIndex]);
  const trailHoursTitle = t('map.aircraftTrailHours', { defaultValue: 'Trail lookback' });
  const onTrailSlider = (idx: number) => {
    setDraftIndex(idx);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      setDraftIndex(null);
      onTrailHoursChange?.(AIRCRAFT_TRAIL_HOUR_STOPS[idx]);
    }, TRAIL_HOURS_COMMIT_MS);
  };
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
      {onShowAgedOutChange && (
        <label className={styles.agedOutOption} data-testid="map-aircraft-show-aged-out">
          <input
            type="checkbox"
            checked={showAgedOut}
            onChange={(e) => onShowAgedOutChange(e.target.checked)}
          />
          <span>{t('map.aircraftShowAgedOut', { defaultValue: 'Show aged-out' })}</span>
        </label>
      )}
      {onShowTrailsChange && (
        <label className={styles.agedOutOption} data-testid="map-aircraft-show-trails">
          <input
            type="checkbox"
            checked={showTrails}
            onChange={(e) => onShowTrailsChange(e.target.checked)}
          />
          <span>{t('map.aircraftTrails', { defaultValue: 'Flight trails' })}</span>
        </label>
      )}
      {onShowTrailsChange && showTrails && (
        <div className={styles.trailHours} data-testid="map-aircraft-trail-hours">
          <div className="position-history-slider">
            <input
              type="range"
              min={0}
              max={AIRCRAFT_TRAIL_HOUR_STOPS.length - 1}
              step={1}
              value={sliderIndex}
              aria-label={trailHoursTitle}
              aria-valuetext={trailHoursLabel}
              onChange={(e) => onTrailSlider(parseInt(e.target.value, 10))}
            />
          </div>
          <span className={styles.hint}>
            {trailHoursTitle}:{' '}
            {t('map.aircraftTrailHoursValue', { value: trailHoursLabel, defaultValue: 'Last {{value}}' })}
          </span>
          <span className={styles.hint}>
            {t('map.aircraftTrailHint', {
              defaultValue: "Draws each aircraft's path from stored positions. Nothing is sent over the mesh.",
            })}
          </span>
        </div>
      )}
      <span className={styles.hint}>
        {t('map.aircraftHint', {
          defaultValue: "Flagged when a node is more than the source's threshold above the terrain.",
        })}
        {aircraftCount != null
          ? ` ${t('map.aircraftCount', { count: aircraftCount, defaultValue: '{{count}} on the map.' })}`
          : ''}
        {onShowAgedOutChange && agedOutCount != null
          ? ` ${t('map.aircraftAgedOutCount', { count: agedOutCount, defaultValue: '{{count}} aged out.' })}`
          : ''}
      </span>
    </div>
  );
}
