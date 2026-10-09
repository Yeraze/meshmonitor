/**
 * Site Planner panel (#4727).
 *
 * The control surface for predictive RF coverage. A dedicated panel rather
 * than a toolbar entry (maintainer decision): every other map layer is data
 * plus a lookback toggle, whereas this needs origin, antenna heights and a
 * link budget, and it needs room to state what the model does not account for.
 *
 * Radio parameters seed from the source's live LoRa config and stay editable.
 * Which fields actually came from the device is surfaced, because a prediction
 * silently computed on a guessed frequency looks exactly as authoritative as
 * one computed on the real thing.
 *
 * Collapsible (#5687). On a phone the full form covers the whole map, so the
 * ring a prediction just drew was invisible until the panel was closed. After
 * a successful prediction on the mobile layout the panel folds to a thin bar
 * (result summary + Edit inputs / Clear), and every viewport gets a manual
 * collapse toggle. The form is hidden rather than unmounted, so a half-typed
 * value survives a collapse exactly as typed.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons/UiIcon';
import { buildSitePlannerDefaults, type SitePlannerDefaults, type LoraConfigLike } from './sitePlannerDefaults';
import type { PredictedCoverage } from '../map/layers/predictedCoverageGeometry';
import { radiusLimitedFraction, hasAnyDataGaps, hasAnyPockets } from '../map/layers/predictedCoverageGeometry';
import type { SitePlannerOrigin } from './SitePlannerOriginController';
import styles from './SitePlannerPanel.module.css';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { useIsMobileLayoutViewport } from '../../hooks/useIsMobileViewport';

export interface SitePlannerPanelProps {
  open: boolean;
  sourceId?: string | null;
  origin: SitePlannerOrigin | null;
  onClose: () => void;
  onCoverage: (coverage: PredictedCoverage | null) => void;
}

export default function SitePlannerPanel({
  open, sourceId, origin, onClose, onCoverage,
}: SitePlannerPanelProps) {
  const { t } = useTranslation();
  const [params, setParams] = useState<SitePlannerDefaults>(() => buildSitePlannerDefaults(null));
  /**
   * Which source the current values were seeded from. Keyed by source rather
   * than a plain boolean so switching sources re-seeds: carrying one radio's
   * frequency and power over to another would predict with the wrong radio
   * while still claiming the values were read from a device (review, #4746).
   */
  const [seededFor, setSeededFor] = useState<string | null | undefined>(undefined);
  const seeded = seededFor === (sourceId ?? null);
  const [running, setRunning] = useState(false);
  const numberScope = useNumberInputScope();
  const numbersInvalid = numberScope.invalid;
  const [error, setError] = useState<string | null>(null);
  // Keep the last result so the panel can explain the SHAPE — a circle usually
  // means the link budget outran terrain within the radius, or terrain data was
  // missing, not that terrain is ignored (#4727 follow-up).
  const [result, setResult] = useState<PredictedCoverage | null>(null);
  // #5687: folded to a bar so the drawn ring is visible. Auto-set only on the
  // mobile layout (the app's shared phone definition, landscape included);
  // on a desktop the panel sits beside the ring and its shape notices are the
  // point of the #4727 fix, so they stay on screen unless the user folds them.
  const [collapsed, setCollapsed] = useState(false);
  const isMobileLayout = useIsMobileLayoutViewport();
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyId = useId();
  // Where focus goes once a fold/unfold has committed. Applied in an effect so
  // the target exists and is visible; a frame callback would not run in a
  // backgrounded tab.
  const pendingFocus = useRef<'toggle' | 'firstInput' | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'toggle') toggleRef.current?.focus();
    else if (target === 'firstInput') {
      panelRef.current?.querySelector<HTMLInputElement>('[data-testid="site-planner-frequencyMhz"]')?.focus();
    }
  }, [collapsed]);

  // Re-opening shows the form, as it did before the panel could fold. Adjusted
  // during render (React's prop-change pattern) rather than in an effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setCollapsed(false);
  }

  // Seed once per source. Re-seeding on every open would discard edits the
  // user made deliberately.
  useEffect(() => {
    if (!open || seeded) return;
    let cancelled = false;
    void (async () => {
      try {
        const config = await apiService.getCurrentConfig(sourceId ?? undefined);
        if (cancelled) return;
        setParams(buildSitePlannerDefaults(config?.deviceConfig?.lora as LoraConfigLike | undefined));
      } catch {
        // A device that cannot be reached is not an error here — the planner
        // still works on fallbacks, and `seededFrom` stays empty so the UI
        // says the values are assumed.
        if (!cancelled) setParams(buildSitePlannerDefaults(null));
      } finally {
        if (!cancelled) setSeededFor(sourceId ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, seeded, sourceId]);

  const update = <K extends keyof SitePlannerDefaults>(key: K, value: SitePlannerDefaults[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const predict = useCallback(async () => {
    // #5649: never predict on a blank or half-typed parameter.
    if (!origin || numbersInvalid) return;
    // Read before the Run button disables: a disabled button drops focus to
    // <body>, so after the await this can no longer be asked of the DOM.
    const focusWasInPanel = !!panelRef.current?.contains(document.activeElement);
    setRunning(true);
    setError(null);
    try {
      const res = await apiService.post<{ success: boolean; data: PredictedCoverage }>(
        '/api/rf/coverage',
        {
          origin: { lat: origin.lat, lng: origin.lng },
          txHeightM: params.txHeightM,
          rxHeightM: params.rxHeightM,
          frequencyHz: params.frequencyHz,
          txPowerDbm: params.txPowerDbm,
          txGainDbi: params.txGainDbi,
          rxGainDbi: params.rxGainDbi,
          lossesDb: params.lossesDb,
          sensitivityDbm: params.sensitivityDbm,
          radiusKm: params.radiusKm,
        },
      );
      setResult(res?.data ?? null);
      onCoverage(res?.data ?? null);
      if (isMobileLayout && res?.data) {
        // The form is about to be hidden; hand focus to the expand toggle so
        // keyboard and screen-reader users are not left on <body>. Only when
        // the user started from the panel and has not moved on — someone who
        // tapped the map while waiting keeps whatever they tapped.
        const active = document.activeElement;
        const focusStillOurs = active === document.body || !!panelRef.current?.contains(active);
        if (focusWasInPanel && focusStillOurs) pendingFocus.current = 'toggle';
        setCollapsed(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('site_planner.failed'));
      setResult(null);
      onCoverage(null);
      // An error is useless folded away: show it next to the inputs.
      setCollapsed(false);
    } finally {
      setRunning(false);
    }
  }, [origin, params, onCoverage, t, numbersInvalid, isMobileLayout]);

  const clear = () => { setResult(null); onCoverage(null); };

  const editInputs = () => {
    // Land on the first field: "Edit inputs" means the user wants to type.
    pendingFocus.current = 'firstInput';
    setCollapsed(false);
  };

  if (!open) return null;

  /**
   * One line for the folded bar. Carries the two shape facts that change how
   * the ring should be read (#4727): a radius-limited edge and missing terrain.
   * The full explanations stay in the expanded panel.
   */
  const summarize = (r: PredictedCoverage): string => {
    const reach = Math.max(0, ...(r.radials ?? []).map((x) => x.reachKm));
    const parts = [t('site_planner.summary', { reach: reach.toFixed(1), radius: r.radiusKm })];
    const limited = radiusLimitedFraction(r);
    if (limited > 0) {
      parts.push(t('site_planner.summary_radius_limited', { percent: Math.round(limited * 100) }));
    }
    if (hasAnyDataGaps(r)) parts.push(t('site_planner.summary_data_gaps'));
    return parts.join(' ');
  };

  const num = (key: keyof SitePlannerDefaults, label: string, step = 1) => (
    <label className={styles.sitePlannerField}>
      <span>{label}</span>
      <NumberInput
        step={step}
        value={params[key] as number}
        data-testid={`site-planner-${key}`}
        onChange={(v) => update(key, v as never)}
      />
    </label>
  );

  return (
    <NumberInputScope scope={numberScope}>
    <aside
      ref={panelRef}
      className={`${styles.sitePlanner} ${collapsed ? styles.sitePlannerCollapsed : ''}`}
      data-testid="site-planner-panel"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className={styles.sitePlannerHead}>
        <h3><UiIcon name="activity" /> {t('site_planner.title')}</h3>
        <div className={styles.sitePlannerHeadButtons}>
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            aria-label={collapsed ? t('site_planner.expand') : t('site_planner.collapse')}
            title={collapsed ? t('site_planner.expand') : t('site_planner.collapse')}
            data-testid="site-planner-toggle"
          >
            <UiIcon name={collapsed ? 'chevronDown' : 'chevronUp'} />
          </button>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <UiIcon name="close" />
          </button>
        </div>
      </header>

      {collapsed && (
        <div className={styles.sitePlannerBar} data-testid="site-planner-bar">
          <p className={styles.sitePlannerSummary} data-testid="site-planner-summary" aria-live="polite">
            {running ? t('site_planner.running') : result ? summarize(result) : t('site_planner.collapsed_hint')}
          </p>
          <div className={styles.sitePlannerActions}>
            <button
              type="button"
              className={styles.sitePlannerRun}
              onClick={editInputs}
              data-testid="site-planner-edit"
            >
              {t('site_planner.edit_inputs')}
            </button>
            {result && (
              <button type="button" onClick={clear} data-testid="site-planner-bar-clear">
                {t('site_planner.clear')}
              </button>
            )}
          </div>
        </div>
      )}

      <div id={bodyId} hidden={collapsed} data-testid="site-planner-body">

        <p className={styles.sitePlannerHint} data-testid="site-planner-origin">
          {origin
            ? (origin.isNode
                ? t('site_planner.origin_node', { name: origin.name ?? origin.id })
                : t('site_planner.origin_point', {
                    lat: origin.lat.toFixed(5),
                    lng: origin.lng.toFixed(5),
                  }))
            : t('site_planner.pick_origin')}
        </p>

        <div className={styles.sitePlannerGrid}>
          {/* Shown in MHz: nobody reasons about a radio in hertz, and this was
              seeded-but-unreachable before — a non-US user whose seeding failed
              had no way to correct the band (review, #4746). */}
          <label className={styles.sitePlannerField}>
            <span>{t('site_planner.frequency')}</span>
            <NumberInput
              step={0.1}
              value={Math.round((params.frequencyHz / 1e6) * 10) / 10}
              data-testid="site-planner-frequencyMhz"
              onChange={(v) => update('frequencyHz', v * 1e6)}
            />
          </label>
          {num('txHeightM', t('site_planner.tx_height'))}
          {num('rxHeightM', t('site_planner.rx_height'))}
          {num('radiusKm', t('site_planner.radius'))}
          {num('txPowerDbm', t('site_planner.tx_power'))}
          {num('txGainDbi', t('site_planner.tx_gain'))}
          {num('sensitivityDbm', t('site_planner.sensitivity'))}
        </div>

        {/* Which numbers are real and which are assumed. A prediction computed on
            a guessed frequency looks exactly as confident as one that isn't. */}
        <p className={styles.sitePlannerSeeded} data-testid="site-planner-seeded">
          {params.unknownRegion != null
            ? t('site_planner.unknown_region', { region: params.unknownRegion })
            : params.seededFrom.length > 0
              ? t('site_planner.seeded', { fields: params.seededFrom.join(', ') })
              : t('site_planner.not_seeded')}
        </p>

        {error && <p className={styles.sitePlannerError} role="alert">{error}</p>}

        <div className={styles.sitePlannerActions}>
          <button
            type="button"
            className={styles.sitePlannerRun}
            disabled={!origin || running || numbersInvalid}
              data-testid="site-planner-run"
            onClick={() => void predict()}
          >
            {running ? t('site_planner.running') : t('site_planner.predict')}
          </button>
          <button
            type="button"
            onClick={clear}
            data-testid="site-planner-clear"
          >
            {t('site_planner.clear')}
          </button>
        </div>

        {/* Explain the SHAPE right here in the panel — the per-polygon popup was
            too easy to miss, so a circle read as "terrain ignored" (#4727). */}
        {result && (() => {
          const limited = radiusLimitedFraction(result);
          const gaps = hasAnyDataGaps(result);
          const pockets = hasAnyPockets(result);
          if (!gaps && limited === 0 && !pockets) return null;
          return (
            <div className={styles.sitePlannerNotice} data-testid="site-planner-notice">
              {gaps && (
                <p className={styles.sitePlannerNoticeWarn} data-testid="site-planner-notice-gaps">
                  {t('site_planner.result_data_gaps')}
                </p>
              )}
              {limited > 0 && (
                <p data-testid="site-planner-notice-radius">
                  {t('site_planner.result_radius_limited', {
                    percent: Math.round(limited * 100),
                    radius: result.radiusKm,
                  })}
                </p>
              )}
              {pockets && <p data-testid="site-planner-notice-pockets">{t('site_planner.result_pockets')}</p>}
            </div>
          );
        })()}

        <p className={styles.sitePlannerCaveat}>{t('site_planner.caveat')}</p>
      </div>
    </aside>
    </NumberInputScope>
  );
}
