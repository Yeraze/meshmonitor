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
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { UiIcon } from '../icons/UiIcon';
import { buildSitePlannerDefaults, type SitePlannerDefaults, type LoraConfigLike } from './sitePlannerDefaults';
import type { PredictedCoverage } from '../map/layers/predictedCoverageGeometry';
import type { SitePlannerOrigin } from './SitePlannerOriginController';
import styles from './SitePlannerPanel.module.css';

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
  const [error, setError] = useState<string | null>(null);

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
    if (!origin) return;
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
      onCoverage(res?.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('site_planner.failed'));
      onCoverage(null);
    } finally {
      setRunning(false);
    }
  }, [origin, params, onCoverage, t]);

  if (!open) return null;

  const num = (key: keyof SitePlannerDefaults, label: string, step = 1) => (
    <label className={styles.sitePlannerField}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={params[key] as number}
        data-testid={`site-planner-${key}`}
        onChange={(e) => update(key, Number(e.target.value) as never)}
      />
    </label>
  );

  return (
    <aside className={styles.sitePlanner} data-testid="site-planner-panel">
      <header className={styles.sitePlannerHead}>
        <h3><UiIcon name="activity" /> {t('site_planner.title')}</h3>
        <button type="button" onClick={onClose} aria-label={t('common.close')}>
          <UiIcon name="close" />
        </button>
      </header>

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
          <input
            type="number"
            step={0.1}
            value={Math.round((params.frequencyHz / 1e6) * 10) / 10}
            data-testid="site-planner-frequencyMhz"
            onChange={(e) => update('frequencyHz', Number(e.target.value) * 1e6)}
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
          disabled={!origin || running}
          data-testid="site-planner-run"
          onClick={() => void predict()}
        >
          {running ? t('site_planner.running') : t('site_planner.predict')}
        </button>
        <button type="button" onClick={() => onCoverage(null)} data-testid="site-planner-clear">
          {t('site_planner.clear')}
        </button>
      </div>

      <p className={styles.sitePlannerCaveat}>{t('site_planner.caveat')}</p>
    </aside>
  );
}
