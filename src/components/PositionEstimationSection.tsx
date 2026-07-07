import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';

interface PositionEstimationSectionProps {
  baseUrl: string;
}

interface EstimationStatus {
  running: boolean;
  inProgress: boolean;
  enabled: boolean;
  frequencyHours: number;
  lookbackHours: number;
  maxUncertaintyKm: number;
  lastRunTime: number | null;
  lastRunResult: {
    estimatedNodeCount: number;
    observationCount: number;
    anchorCount: number;
    rejectedNodeCount?: number;
    durationMs: number;
  } | null;
}

const FREQUENCY_OPTIONS = [3, 6, 12, 24];
const LOOKBACK_OPTIONS = [24, 72, 168, 336, 720]; // 1d, 3d, 7d, 14d, 30d

/**
 * Global, batch position estimation settings (issue #3271). Estimation pools
 * traceroute + neighbor observations across all Meshtastic sources (incl. MQTT)
 * into one estimate per node, on a scheduled interval. These settings are global
 * (saved without a source scope).
 */
const PositionEstimationSection: React.FC<PositionEstimationSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();

  const [enabled, setEnabled] = useState(true);
  const [frequencyHours, setFrequencyHours] = useState(6);
  const [lookbackHours, setLookbackHours] = useState(168);
  const [maxUncertaintyKm, setMaxUncertaintyKm] = useState(0);

  const [localEnabled, setLocalEnabled] = useState(true);
  const [localFrequencyHours, setLocalFrequencyHours] = useState(6);
  const [localLookbackHours, setLocalLookbackHours] = useState(168);
  const [localMaxUncertaintyKm, setLocalMaxUncertaintyKm] = useState(0);

  const [status, setStatus] = useState<EstimationStatus | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/position-estimation/status`);
      if (response.ok) {
        const data: EstimationStatus = await response.json();
        setStatus(data);
        setEnabled(data.enabled);
        setFrequencyHours(data.frequencyHours);
        setLookbackHours(data.lookbackHours);
        setMaxUncertaintyKm(data.maxUncertaintyKm ?? 0);
        setLocalEnabled(data.enabled);
        setLocalFrequencyHours(data.frequencyHours);
        setLocalLookbackHours(data.lookbackHours);
        setLocalMaxUncertaintyKm(data.maxUncertaintyKm ?? 0);
      }
    } catch {
      // Status is non-critical; ignore fetch failures.
    }
  }, [csrfFetch, baseUrl]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const hasChanges =
    localEnabled !== enabled ||
    localFrequencyHours !== frequencyHours ||
    localLookbackHours !== lookbackHours ||
    localMaxUncertaintyKm !== maxUncertaintyKm;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position_estimation_enabled: String(localEnabled),
          position_estimation_frequency_hours: String(localFrequencyHours),
          position_estimation_lookback_hours: String(localLookbackHours),
          position_estimation_max_uncertainty_km: String(localMaxUncertaintyKm),
        }),
      });
      if (response.ok) {
        setEnabled(localEnabled);
        setFrequencyHours(localFrequencyHours);
        setLookbackHours(localLookbackHours);
        setMaxUncertaintyKm(localMaxUncertaintyKm);
        showToast(t('automation.settings_saved', 'Settings saved'), 'success');
      } else {
        showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localFrequencyHours, localLookbackHours, localMaxUncertaintyKm, csrfFetch, baseUrl, showToast, t]);

  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalFrequencyHours(frequencyHours);
    setLocalLookbackHours(lookbackHours);
    setLocalMaxUncertaintyKm(maxUncertaintyKm);
  }, [enabled, frequencyHours, lookbackHours, maxUncertaintyKm]);

  useSaveBar({
    id: 'position-estimation',
    sectionName: t('automation.position_estimation.title', 'Position Estimation'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/position-estimation/run-now`, {
        method: 'POST',
      });
      if (response.ok) {
        const result = await response.json();
        showToast(
          t('automation.position_estimation.run_result', {
            count: result.estimatedNodeCount,
            defaultValue: `Estimated ${result.estimatedNodeCount} node position(s)`,
          }),
          'success'
        );
        void fetchStatus();
      } else if (response.status === 409) {
        showToast(t('automation.position_estimation.already_running', 'Estimation already running'), 'warning');
      } else {
        showToast(t('automation.settings_save_failed', 'Failed to run'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to run'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [csrfFetch, baseUrl, showToast, t, fetchStatus]);

  const lookbackLabel = (hours: number): string => {
    if (hours % 24 === 0) return t('automation.position_estimation.lookback_days', { count: hours / 24, defaultValue: `${hours / 24} day(s)` });
    return t('automation.position_estimation.lookback_hours', { count: hours, defaultValue: `${hours} hour(s)` });
  };

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.position_estimation.title', 'Position Estimation')}
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem', marginLeft: 'auto' }}>
          <button
            onClick={handleRunNow}
            disabled={isRunning || status?.inProgress}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: (!isRunning && !status?.inProgress) ? 1 : 0.5,
              cursor: (!isRunning && !status?.inProgress) ? 'pointer' : 'not-allowed'
            }}
          >
            {(isRunning || status?.inProgress)
              ? t('automation.position_estimation.running', 'Running…')
              : t('automation.position_estimation.run_now', 'Recalculate now')}
          </button>
        </div>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.position_estimation.description',
            'Estimate locations for nodes without GPS by pooling traceroute and neighbor data across all Meshtastic sources (including MQTT). Runs on a schedule; estimates are shared across every source.')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.position_estimation.frequency', 'Calculation frequency')}</label>
          <select
            value={localFrequencyHours}
            onChange={(e) => setLocalFrequencyHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {FREQUENCY_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {t('automation.position_estimation.every_hours', { count: h, defaultValue: `Every ${h} hours` })}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.position_estimation.lookback', 'Lookback window')}</label>
          <select
            value={localLookbackHours}
            onChange={(e) => setLocalLookbackHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {LOOKBACK_OPTIONS.map((h) => (
              <option key={h} value={h}>{lookbackLabel(h)}</option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>{t('automation.position_estimation.max_uncertainty', 'Maximum acceptable accuracy (km)')}</label>
          <input
            type="number"
            min={0}
            step={0.5}
            value={localMaxUncertaintyKm}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setLocalMaxUncertaintyKm(Number.isFinite(v) && v > 0 ? v : 0);
            }}
            disabled={!localEnabled}
            className="setting-input"
          />
          <p style={{ fontSize: '12px', color: 'var(--ctp-subtext0)', margin: '0.35rem 0 0 0' }}>
            {t('automation.position_estimation.max_uncertainty_help',
              'Estimates with an uncertainty radius larger than this are discarded rather than stored, so low-confidence guesses don’t draw huge circles on the map. Set 0 for no limit.')}
          </p>
        </div>

        {status && (
          <div style={{ marginTop: '1.5rem', marginLeft: '1.75rem', fontSize: '13px', color: 'var(--ctp-subtext1)' }}>
            <div>
              {t('automation.position_estimation.last_run', 'Last run')}:{' '}
              {status.lastRunTime ? new Date(status.lastRunTime).toLocaleString() : t('automation.position_estimation.never', 'never')}
            </div>
            {status.lastRunResult && (
              <div style={{ marginTop: '0.25rem' }}>
                {t('automation.position_estimation.last_result', {
                  estimated: status.lastRunResult.estimatedNodeCount,
                  observations: status.lastRunResult.observationCount,
                  anchors: status.lastRunResult.anchorCount,
                  defaultValue: `${status.lastRunResult.estimatedNodeCount} node(s) estimated from ${status.lastRunResult.observationCount} observation(s), ${status.lastRunResult.anchorCount} anchor(s)`,
                })}
                {status.lastRunResult.rejectedNodeCount ? (
                  <>
                    {' '}
                    {t('automation.position_estimation.last_rejected', {
                      count: status.lastRunResult.rejectedNodeCount,
                      defaultValue: `(${status.lastRunResult.rejectedNodeCount} discarded over max accuracy)`,
                    })}
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default PositionEstimationSection;
