/**
 * Map Features control for the ducting overlay (#5734): the toggle, the time
 * scrubber (now to +72 h in 3 h steps) and the legend.
 *
 * Rendered by every Map Features panel (NodesTab, DashboardMap and, since
 * #5972, MeshCoreMap). It renders nothing unless an admin switched the
 * overlay on (`ductingOverlayEnabled`).
 *
 * The scrubber commits a step only after it has rested for
 * `DUCTING_SCRUB_DEBOUNCE_MS`, so dragging across 25 steps asks the server for
 * one step, not 25. A failed fetch shows one inline line here; it never
 * retries on its own.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import { ApiError } from '../../services/api';
import {
  DUCTING_MAX_HOURS_AHEAD,
  DUCTING_STEP_HOURS,
  useDuctingEnabled,
  useDuctingForecast,
} from '../../hooks/useDuctingForecast';
import {
  DUCT_STRENGTH_SATURATION_M,
  DUCTING_MAX_OPACITY,
  DUCTING_MIN_OPACITY,
  DUCTING_SCRUB_DEBOUNCE_MS,
  SUPER_REFRACTIVE_OPACITY,
  formatGfsCycle,
  formatValidTimeLocal,
} from './layers/ductingGeometry';
import layerStyles from './layers/DuctingLayer.module.css';
import styles from './DuctingControl.module.css';

const MAX_STEP = DUCTING_MAX_HOURS_AHEAD / DUCTING_STEP_HOURS;

export interface DuctingControlProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The committed step, hours ahead. */
  hoursAhead: number;
  onHoursAheadChange: (hours: number) => void;
  /** When set, the toggle is disabled with this title (e.g. in 3D view). */
  disabledTitle?: string;
  /** #5972: forecast this one source's area. Pass the same value as the map's DuctingLayer. */
  sourceId?: string | null;
}

export function DuctingControl({ checked, onCheckedChange, hoursAhead, onHoursAheadChange, disabledTitle, sourceId }: DuctingControlProps) {
  const { t } = useTranslation();
  const enabled = useDuctingEnabled();
  const active = enabled && checked && !disabledTitle;
  const query = useDuctingForecast(hoursAhead, active, sourceId);

  // The slider moves at once; the committed step follows after a rest.
  const [pendingStep, setPendingStep] = useState(Math.round(hoursAhead / DUCTING_STEP_HOURS));
  useEffect(() => {
    setPendingStep(Math.round(hoursAhead / DUCTING_STEP_HOURS));
  }, [hoursAhead]);
  useEffect(() => {
    const hours = pendingStep * DUCTING_STEP_HOURS;
    if (hours === hoursAhead) return;
    const timer = setTimeout(() => onHoursAheadChange(hours), DUCTING_SCRUB_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pendingStep, hoursAhead, onHoursAheadChange]);

  if (!enabled) return null;

  const pendingHours = pendingStep * DUCTING_STEP_HOURS;
  const settled = pendingHours === hoursAhead && !query.isPlaceholderData;
  const data = settled ? query.data : undefined;

  let status: string | null = null;
  if (active && query.error) {
    const err = query.error;
    const code = err instanceof ApiError ? err.code : undefined;
    const httpStatus = err instanceof ApiError ? err.status : undefined;
    if (httpStatus === 503) status = t('map.ducting.error_unavailable', 'NOAA forecast is not available right now.');
    else if (httpStatus === 502) status = t('map.ducting.error_unreadable', 'NOAA sent data MeshMonitor could not read.');
    else if (code === 'NO_AREA') status = t('map.ducting.error_no_area', 'No recently heard node has a position, so there is no area to forecast.');
    else status = t('map.ducting.error_generic', 'Could not load the ducting forecast.');
  } else if (active && (query.isFetching || !settled)) {
    status = t('map.ducting.loading', 'Loading forecast…');
  }

  return (
    <div className={styles.root} data-testid="ducting-control">
      <label
        className="map-control-item"
        title={disabledTitle ?? t('map.ducting.toggle_hint', 'Where the lower atmosphere bends radio further than usual (NOAA GFS forecast).')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={!!disabledTitle}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        <UiIcon name="ducting" size={14} />
        <span>{t('map.ducting.toggle', 'Ducting')}</span>
      </label>

      {active && (
        <div className={styles.panel}>
          <label className={styles.scrubberLabel} htmlFor="ducting-scrubber">
            <span data-testid="ducting-step" data-hours={pendingHours}>
              {t('map.ducting.hours_ahead', '+{{hours}} h', { hours: pendingHours })}
            </span>
            {data && (
              <span className={styles.validTime} data-testid="ducting-valid-time">
                {formatValidTimeLocal(data.validTime)}
              </span>
            )}
          </label>
          <input
            id="ducting-scrubber"
            className={styles.scrubber}
            type="range"
            min={0}
            max={MAX_STEP}
            step={1}
            value={pendingStep}
            onChange={(e) => setPendingStep(Number(e.target.value))}
            aria-label={t('map.ducting.scrubber_label', 'Forecast time')}
            aria-valuetext={t('map.ducting.hours_ahead', '+{{hours}} h', { hours: pendingHours })}
            title={t(
              'map.ducting.caveat',
              'GFS pressure levels sit 200-500 m apart near the ground, so sharp ducts can read weaker than they are.',
            )}
          />
          {data && (
            <div className={styles.meta} data-testid="ducting-cycle">
              {t('map.ducting.cycle', 'GFS run')} {formatGfsCycle(data.cycle)}
            </div>
          )}
          {status && (
            <div className={query.error ? styles.error : styles.meta} role={query.error ? 'alert' : 'status'}>
              {status}
            </div>
          )}

          <ul className={styles.legend} aria-label={t('map.ducting.legend', 'Ducting legend')}>
            <li>
              <span className={`${styles.swatch} ${styles.swatchNone}`} aria-hidden="true" />
              {t('map.ducting.class_normal', 'Normal: no fill')}
            </li>
            <li>
              <svg className={styles.swatch} viewBox="0 0 10 10" aria-hidden="true">
                <rect width="10" height="10" className={layerStyles.super} fillOpacity={SUPER_REFRACTIVE_OPACITY} />
              </svg>
              {t('map.ducting.class_super', 'Super-refractive (≤ −79 N/km)')}
            </li>
            <li>
              <svg className={styles.swatchWide} viewBox="0 0 30 10" aria-hidden="true">
                <rect x="0" width="10" height="10" className={layerStyles.duct} fillOpacity={DUCTING_MIN_OPACITY} />
                <rect x="10" width="10" height="10" className={layerStyles.duct} fillOpacity={(DUCTING_MIN_OPACITY + DUCTING_MAX_OPACITY) / 2} />
                <rect x="20" width="10" height="10" className={layerStyles.duct} fillOpacity={DUCTING_MAX_OPACITY} />
              </svg>
              {t('map.ducting.class_duct', 'Ducting (≤ −157 N/km), darker = stronger (ΔM to {{max}}+)', {
                max: DUCT_STRENGTH_SATURATION_M,
              })}
            </li>
          </ul>
          <div className={styles.caveat}>
            {t(
              'map.ducting.caveat',
              'GFS pressure levels sit 200-500 m apart near the ground, so sharp ducts can read weaker than they are.',
            )}
          </div>
          <div className={styles.attribution}>{t('map.ducting.attribution', 'Data: NOAA GFS')}</div>
        </div>
      )}
    </div>
  );
}

export default DuctingControl;
