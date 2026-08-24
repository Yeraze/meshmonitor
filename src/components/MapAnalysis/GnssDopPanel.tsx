/**
 * GNSS DOP overlay panel (#4729).
 *
 * The control surface for the DOP heatmap. Modeled on `SitePlannerPanel`, but
 * its defining control is a TIME scrubber the Site Planner has no need for:
 * satellite geometry — and therefore GDOP — changes minute to minute as the
 * constellation moves overhead, so the overlay must be able to ask "how good
 * will positioning be *here*, at *this* time". Elevation mask and constellation
 * round out the inputs.
 *
 * A short caveat states plainly that DOP is time/latitude-driven, NOT terrain —
 * so, unlike the Site Planner sitting next to it, the map recomputes as time
 * changes rather than as elevation does.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import {
  DOP_GOOD,
  DOP_MODERATE,
  DOP_POOR,
  gdopToColor,
  type GnssDopMeta,
  type GnssDopUiParams,
} from '../map/layers/gnssDopGeometry';
import styles from './GnssDopPanel.module.css';

export interface GnssDopPanelProps {
  open: boolean;
  params: GnssDopUiParams;
  meta: GnssDopMeta | null;
  onChange: (params: GnssDopUiParams) => void;
  onClose: () => void;
}

/** How far either side of the anchor the time scrubber reaches. */
const TIME_RANGE_HOURS = 12;
const HOUR_MS = 3_600_000;

/** Constellations offered in the picker. Only GPS is live in v1; the rest are
 *  shown disabled so users see they're coming, not that they're missing. */
const CONSTELLATIONS: Array<{ id: string; label: string; enabled: boolean }> = [
  { id: 'gps', label: 'GPS', enabled: true },
  { id: 'galileo', label: 'Galileo', enabled: false },
  { id: 'glonass', label: 'GLONASS', enabled: false },
  { id: 'beidou', label: 'BeiDou', enabled: false },
];

/** Legend swatches spanning the good→poor ramp. */
const LEGEND_STOPS: Array<{ gdop: number; label: string }> = [
  { gdop: DOP_GOOD - 0.5, label: `≤ ${DOP_GOOD}` },
  { gdop: (DOP_GOOD + DOP_MODERATE) / 2, label: `${DOP_MODERATE}` },
  { gdop: DOP_POOR + 1, label: `≥ ${DOP_POOR}` },
];

export default function GnssDopPanel({ open, params, meta, onChange, onClose }: GnssDopPanelProps) {
  const { t } = useTranslation();

  // Anchor "now" to the real wall clock at mount, so the scrubber offset is
  // measured from the actual current time and stays stable while dragging; the
  // Now button re-anchors and returns to offset 0. #4797(3): anchoring to
  // `params.timeMs` instead meant that on remount (leave Map Analysis and come
  // back) the anchor became whatever time was preserved in context — so a stale
  // preserved time read as offset 0 / "now" when it was actually in the past.
  const anchorRef = useRef<number>(Date.now());
  const offsetHours = Math.round(((params.timeMs - anchorRef.current) / HOUR_MS) * 10) / 10;

  const setTimeOffset = (hours: number) => {
    onChange({ ...params, timeMs: anchorRef.current + hours * HOUR_MS });
  };
  const resetToNow = () => {
    anchorRef.current = Date.now();
    onChange({ ...params, timeMs: anchorRef.current });
  };
  const setMask = (raw: number) => {
    const maskDeg = Number.isFinite(raw) ? Math.max(0, Math.min(90, raw)) : 0;
    onChange({ ...params, maskDeg });
  };

  if (!open) return null;

  const offsetLabel =
    offsetHours === 0
      ? t('gnss_dop.time_now')
      : t('gnss_dop.time_offset', { sign: offsetHours > 0 ? '+' : '', hours: offsetHours });

  return (
    <aside className={styles.gnssDop} data-testid="gnss-dop-panel">
      <header className={styles.gnssDopHead}>
        <h3><UiIcon name="target" /> {t('gnss_dop.title')}</h3>
        <button type="button" onClick={onClose} aria-label={t('common.close')}>
          <UiIcon name="close" />
        </button>
      </header>

      {/* Time — the control that sets this apart from the Site Planner. */}
      <div className={styles.gnssDopField}>
        <div className={styles.gnssDopTimeHead}>
          <span><UiIcon name="time" size={14} /> {t('gnss_dop.time')}</span>
          <button
            type="button"
            className={styles.gnssDopNow}
            data-testid="gnss-dop-time-now"
            onClick={resetToNow}
          >
            {t('gnss_dop.now')}
          </button>
        </div>
        <input
          type="range"
          min={-TIME_RANGE_HOURS}
          max={TIME_RANGE_HOURS}
          step={0.5}
          value={Math.max(-TIME_RANGE_HOURS, Math.min(TIME_RANGE_HOURS, offsetHours))}
          data-testid="gnss-dop-time"
          aria-label={t('gnss_dop.time')}
          onChange={(e) => setTimeOffset(Number(e.target.value))}
        />
        <p className={styles.gnssDopTimeReadout} data-testid="gnss-dop-time-readout">
          {offsetLabel} — {new Date(params.timeMs).toLocaleString()}
        </p>
      </div>

      <label className={styles.gnssDopField}>
        <span>{t('gnss_dop.mask')}</span>
        <input
          type="number"
          min={0}
          max={90}
          step={1}
          value={params.maskDeg}
          data-testid="gnss-dop-mask"
          onChange={(e) => setMask(Number(e.target.value))}
        />
      </label>

      <div className={styles.gnssDopField}>
        <span>{t('gnss_dop.constellations')}</span>
        <div className={styles.gnssDopConstellations}>
          {CONSTELLATIONS.map((c) => {
            const checked = params.constellations.includes(c.id);
            return (
              <label
                key={c.id}
                className={c.enabled ? styles.gnssDopChip : styles.gnssDopChipDisabled}
                title={c.enabled ? undefined : t('gnss_dop.constellation_soon')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!c.enabled}
                  data-testid={`gnss-dop-constellation-${c.id}`}
                  onChange={(e) => {
                    if (!c.enabled) return;
                    const next = e.target.checked
                      ? [...new Set([...params.constellations, c.id])]
                      : params.constellations.filter((x) => x !== c.id);
                    // Never let the set go empty — an empty request would 400.
                    onChange({ ...params, constellations: next.length > 0 ? next : [c.id] });
                  }}
                />
                {c.label}
              </label>
            );
          })}
        </div>
      </div>

      {/* Legend — the GDOP color ramp. */}
      <div className={styles.gnssDopLegend} data-testid="gnss-dop-legend">
        <span className={styles.gnssDopLegendTitle}>{t('gnss_dop.legend')}</span>
        <div className={styles.gnssDopLegendRamp}>
          {LEGEND_STOPS.map((s) => (
            <span key={s.label} className={styles.gnssDopLegendStop}>
              <i style={{ background: gdopToColor(s.gdop) }} aria-hidden />
              {s.label}
            </span>
          ))}
          <span className={styles.gnssDopLegendStop}>
            <i style={{ background: gdopToColor(null) }} aria-hidden />
            {t('gnss_dop.legend_none')}
          </span>
        </div>
      </div>

      {meta?.loading && <p className={styles.gnssDopHint}>{t('gnss_dop.loading')}</p>}
      {meta?.error && (
        <p className={styles.gnssDopError} role="alert">{meta.error}</p>
      )}
      {meta?.clamped && !meta.error && (
        <p className={styles.gnssDopHint} data-testid="gnss-dop-clamped">
          {t('gnss_dop.clamped')}
        </p>
      )}

      <p className={styles.gnssDopCaveat}>{t('gnss_dop.caveat')}</p>
    </aside>
  );
}
