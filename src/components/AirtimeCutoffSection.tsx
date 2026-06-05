import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import { useToast } from './ToastContainer';

interface AirtimeCutoffSectionProps {
  baseUrl: string;
}

type AirtimeSource = 'local' | 'neighbors';

interface AirtimeStatus {
  threshold: number;
  source: AirtimeSource;
  channelUtilization: number | null;
  sampleCount: number;
  gated: boolean;
}

const DEFAULT_THRESHOLD = 30;
const DEFAULT_SOURCE: AirtimeSource = 'local';
const STATUS_POLL_MS = 15000;

/**
 * "Cutoff Airtime Utilization Threshold" — pauses all transmitting automations
 * (auto-traceroute, auto-announce, timers, etc.) whenever the connected node's
 * self-reported Channel Utilization exceeds the configured threshold, so bots
 * back off while real traffic is heavy. 0 disables the feature.
 */
const AirtimeCutoffSection: React.FC<AirtimeCutoffSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();

  const [localThreshold, setLocalThreshold] = useState(DEFAULT_THRESHOLD);
  const [initialThreshold, setInitialThreshold] = useState<number | null>(null);
  const [localSource, setLocalSource] = useState<AirtimeSource>(DEFAULT_SOURCE);
  const [initialSource, setInitialSource] = useState<AirtimeSource | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<AirtimeStatus | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`);
      if (res.ok) {
        const settings = await res.json();
        const raw = parseInt(settings.automationAirtimeCutoffThreshold ?? String(DEFAULT_THRESHOLD), 10);
        const threshold = Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : DEFAULT_THRESHOLD;
        const source: AirtimeSource = settings.automationAirtimeCutoffSource === 'neighbors' ? 'neighbors' : DEFAULT_SOURCE;
        setLocalThreshold(threshold);
        setInitialThreshold(threshold);
        setLocalSource(source);
        setInitialSource(source);
      }
    } catch (error) {
      console.error('Failed to fetch airtime cutoff settings:', error);
    }
  }, [baseUrl, csrfFetch, sourceQuery]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/automation/airtime-status${sourceQuery}`);
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch (error) {
      console.error('Failed to fetch airtime cutoff status:', error);
    }
  }, [baseUrl, csrfFetch, sourceQuery]);

  useEffect(() => {
    fetchSettings();
    fetchStatus();
  }, [fetchSettings, fetchStatus]);

  // Poll the live status so the banner reflects current utilization.
  useEffect(() => {
    const id = setInterval(fetchStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    if (initialThreshold === null || initialSource === null) return;
    setHasChanges(localThreshold !== initialThreshold || localSource !== initialSource);
  }, [localThreshold, initialThreshold, localSource, initialSource]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          automationAirtimeCutoffThreshold: String(localThreshold),
          automationAirtimeCutoffSource: localSource,
        }),
      });
      if (response.ok) {
        setInitialThreshold(localThreshold);
        setInitialSource(localSource);
        setHasChanges(false);
        showToast(t('automation.airtime_cutoff.saved', 'Airtime cutoff settings saved'), 'success');
        fetchStatus();
      } else {
        showToast(t('automation.airtime_cutoff.save_error', 'Failed to save settings'), 'error');
      }
    } catch {
      showToast(t('automation.airtime_cutoff.save_error', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [baseUrl, csrfFetch, sourceQuery, localThreshold, localSource, showToast, t, fetchStatus]);

  const resetChanges = useCallback(() => {
    if (initialThreshold !== null) setLocalThreshold(initialThreshold);
    if (initialSource !== null) setLocalSource(initialSource);
  }, [initialThreshold, initialSource]);

  useSaveBar({
    id: 'airtime-cutoff',
    sectionName: t('automation.airtime_cutoff.title', 'Cutoff Airtime Utilization Threshold'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  const disabled = localThreshold === 0;
  const util = status?.channelUtilization;
  const gated = status?.gated ?? false;
  const statusSource: AirtimeSource = status?.source ?? localSource;
  const sampleCount = status?.sampleCount ?? 0;
  const sourceLabel = statusSource === 'neighbors'
    ? t('automation.airtime_cutoff.source_neighbors_label', 'neighbour-averaged')
    : t('automation.airtime_cutoff.source_local_label', 'local');

  // Banner colour: red when paused, green when active, neutral when disabled/unknown.
  const bannerColor = disabled
    ? 'var(--ctp-overlay0)'
    : gated
      ? 'var(--ctp-red)'
      : 'var(--ctp-green)';

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
        <h2 style={{ margin: 0 }}>
          {t('automation.airtime_cutoff.title', 'Cutoff Airtime Utilization Threshold')}
        </h2>
      </div>

      <div className="settings-section">
        <p style={{ marginLeft: '0.25rem', marginBottom: '1rem', color: 'var(--ctp-subtext1)', fontSize: '13px', lineHeight: '1.5' }}>
          {t('automation.airtime_cutoff.description',
            'Pauses all automations (auto-traceroute, auto-announce, timers, etc.) whenever the connected node\'s Channel Utilization rises above this threshold, so bots stop adding traffic while the mesh is busy with real activity. Automations resume automatically once utilization drops back below the threshold. Set to 0 to disable.')}
        </p>

        {/* Live status banner */}
        <div style={{
          marginBottom: '1.25rem',
          padding: '0.6rem 1rem',
          background: 'var(--ctp-surface0)',
          border: `1px solid ${bannerColor}`,
          borderLeft: `4px solid ${bannerColor}`,
          borderRadius: '6px',
          color: bannerColor,
          fontSize: '13px',
          fontWeight: 500,
        }}>
          {disabled
            ? t('automation.airtime_cutoff.status_disabled', 'Airtime cutoff is disabled (threshold 0).')
            : util == null
              ? (statusSource === 'neighbors'
                  ? t('automation.airtime_cutoff.status_unknown_neighbors', 'Waiting for 0-hop infrastructure (router) neighbours to report Channel Utilization…')
                  : t('automation.airtime_cutoff.status_unknown', 'Waiting for the connected node to report Channel Utilization…'))
              : gated
                ? t('automation.airtime_cutoff.status_paused', '⏸ Automations paused — {{source}} Channel Utilization {{util}}% exceeds {{threshold}}%.', { source: sourceLabel, util, threshold: status?.threshold ?? localThreshold })
                : t('automation.airtime_cutoff.status_active', '✓ Automations active — {{source}} Channel Utilization {{util}}% is under {{threshold}}%.', { source: sourceLabel, util, threshold: status?.threshold ?? localThreshold })}
          {!disabled && util != null && statusSource === 'neighbors' && (
            <span style={{ fontWeight: 400, opacity: 0.85 }}>
              {' '}{t('automation.airtime_cutoff.status_neighbors_suffix', '(averaged from {{count}} infrastructure node(s))', { count: sampleCount })}
            </span>
          )}
        </div>

        {/* Measurement source */}
        <div className="setting-item">
          <label htmlFor="airtimeCutoffSource">
            {t('automation.airtime_cutoff.source_label', 'Measure Channel Utilization from')}
            <span className="setting-description">
              {t('automation.airtime_cutoff.source_hint',
                'Local node uses the connected node\'s own Channel Utilization. Nearby infrastructure averages the Channel Utilization of the 3 strongest-RSSI directly-heard router/repeater nodes — useful when your node is well-placed and under-reports the wider mesh.')}
            </span>
          </label>
          <select
            id="airtimeCutoffSource"
            value={localSource}
            onChange={(e) => setLocalSource(e.target.value === 'neighbors' ? 'neighbors' : 'local')}
            className="setting-input"
          >
            <option value="local">{t('automation.airtime_cutoff.source_local_option', 'Local node (own Channel Utilization)')}</option>
            <option value="neighbors">{t('automation.airtime_cutoff.source_neighbors_option', 'Nearby infrastructure (avg of 3 strongest routers)')}</option>
          </select>
        </div>

        {/* Threshold input */}
        <div className="setting-item">
          <label htmlFor="airtimeCutoffThreshold">
            {t('automation.airtime_cutoff.threshold_label', 'Cutoff Airtime Utilization Threshold (%)')}
            <span className="setting-description">
              {t('automation.airtime_cutoff.threshold_hint',
                'Channel Utilization percent above which automations pause. 0 disables; default 30.')}
            </span>
          </label>
          <input
            id="airtimeCutoffThreshold"
            type="number"
            min={0}
            max={100}
            value={localThreshold}
            onChange={(e) => {
              const raw = parseInt(e.target.value, 10);
              const clamped = Number.isNaN(raw) ? 0 : Math.max(0, Math.min(100, raw));
              setLocalThreshold(clamped);
            }}
            className="setting-input"
          />
        </div>
      </div>
    </>
  );
};

export default AirtimeCutoffSection;
