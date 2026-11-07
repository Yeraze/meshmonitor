import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { ConfigSection } from '../shared/config/ConfigSection';
import { kmToMiles } from '../../utils/distance';

/** Miles → km (utils/distance only exports km→miles). */
const milesToKm = (mi: number) => mi * 1.609344;

/**
 * MeshCore Auto Delete by Distance (#6224). Parity with the Meshtastic
 * automation: the per-source `DistanceDeleteScheduler` + shared
 * `autoDeleteByDistanceService` already run for MeshCore sources (#3901); this
 * section just exposes the same per-source settings in the Automation tab.
 * Purging a node is LOCAL only — it never transmits — so this is not gated on
 * receive-only mode.
 */
interface Props {
  baseUrl: string;
  sourceId: string;
}

interface DistanceDeleteSettings {
  enabled: boolean;
  intervalHours: number;
  thresholdKm: number;
  lat: number | null;
  lon: number | null;
  action: 'delete' | 'ignore';
}

const DEFAULTS: DistanceDeleteSettings = {
  enabled: false,
  intervalHours: 24,
  thresholdKm: 100,
  lat: null,
  lon: null,
  action: 'delete',
};

export const MeshCoreAutoDeleteByDistanceSection: React.FC<Props> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const { distanceUnit } = useSettings();
  const canWrite = hasPermission('automation', 'write');
  const isMiles = distanceUnit === 'mi';

  const [settings, setSettings] = useState<DistanceDeleteSettings>(DEFAULTS);
  const [initial, setInitial] = useState<DistanceDeleteSettings>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningNow, setIsRunningNow] = useState(false);
  const loadedRef = useRef(false);
  const url = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/auto-delete-distance`;

  const fetchData = useCallback(async () => {
    try {
      const res = await csrfFetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const data = json?.data;
      if (!data) return;
      if (!loadedRef.current && data.settings) {
        const s: DistanceDeleteSettings = { ...DEFAULTS, ...data.settings };
        setSettings(s);
        setInitial(s);
        loadedRef.current = true;
      }
      setRunning(data.running === true);
    } catch {
      // ignore; keep defaults
    }
  }, [csrfFetch, url]);

  useEffect(() => {
    loadedRef.current = false;
    void fetchData();
  }, [fetchData]);

  const hasChanges =
    settings.enabled !== initial.enabled ||
    settings.intervalHours !== initial.intervalHours ||
    settings.thresholdKm !== initial.thresholdKm ||
    settings.lat !== initial.lat ||
    settings.lon !== initial.lon ||
    settings.action !== initial.action;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        const body = await res.json().catch(() => null);
        showToast(body?.error || t('automation.settings_save_failed', 'Failed to save settings'), 'error');
        return;
      }
      setInitial(settings);
      void fetchData();
      showToast(t('meshcore.automation.delete_distance.saved', 'Auto-delete-by-distance settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-delete-by-distance settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [settings, url, csrfFetch, showToast, t, fetchData]);

  const handleDismiss = useCallback(() => setSettings(initial), [initial]);

  const numberScope = useNumberInputScope();
  useSaveBar({
    numberScope,
    id: 'meshcore-auto-delete-distance',
    sectionName: t('meshcore.automation.delete_distance.title', 'Auto Delete by Distance'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof DistanceDeleteSettings>(key: K, value: DistanceDeleteSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleRunNow = async () => {
    setIsRunningNow(true);
    try {
      const res = await csrfFetch(`${url}/run`, { method: 'POST' });
      if (!res.ok) {
        showToast(t('meshcore.automation.delete_distance.run_failed', 'Failed to run auto-delete'), 'error');
        return;
      }
      const body = await res.json().catch(() => null);
      const count = body?.data?.deletedCount ?? 0;
      showToast(
        t('meshcore.automation.delete_distance.run_done', '{{count}} node(s) processed', { count }),
        'success',
      );
    } catch {
      showToast(t('meshcore.automation.delete_distance.run_failed', 'Failed to run auto-delete'), 'error');
    } finally {
      setIsRunningNow(false);
    }
  };

  const disabled = !settings.enabled || !canWrite;
  // Threshold stored in km; display/edit in the user's unit.
  const displayThreshold = isMiles ? Math.round(kmToMiles(settings.thresholdKm) * 10) / 10 : settings.thresholdKm;
  const unitLabel = isMiles ? t('common.miles', 'miles') : t('common.kilometers', 'km');

  return (
    <NumberInputScope scope={numberScope}>
      <ConfigSection
        title={t('meshcore.automation.delete_distance.title', 'Auto Delete by Distance')}
        enabled={settings.enabled}
        onEnabledChange={(v) => update('enabled', v)}
        enableLabel={t('meshcore.automation.delete_distance.title', 'Auto Delete by Distance')}
        docsUrl="https://meshmonitor.org/features/automation#auto-delete-by-distance"
        canWrite={canWrite}
        description={t(
          'meshcore.automation.delete_distance.description',
          'Periodically remove (or ignore) this source’s nodes beyond a set distance from a home point. Runs locally and never transmits. Favorited nodes and the local node are always kept.',
        )}
      >
        <div className="setting-item">
          <label htmlFor="mcDeleteDistanceAction">
            {t('meshcore.automation.delete_distance.action', 'Action')}
            <span className="setting-description">
              {t('meshcore.automation.delete_distance.action_description', 'Delete removes the node; Ignore keeps it but hides it from maps and lists.')}
            </span>
          </label>
          <select
            id="mcDeleteDistanceAction"
            className="setting-input"
            value={settings.action}
            onChange={(e) => update('action', e.target.value === 'ignore' ? 'ignore' : 'delete')}
            disabled={disabled}
          >
            <option value="delete">{t('meshcore.automation.delete_distance.action_delete', 'Delete')}</option>
            <option value="ignore">{t('meshcore.automation.delete_distance.action_ignore', 'Ignore')}</option>
          </select>
        </div>

        <div className="setting-item">
          <label htmlFor="mcDeleteDistanceThreshold">
            {t('meshcore.automation.delete_distance.threshold', 'Distance threshold ({{unit}})', { unit: unitLabel })}
            <span className="setting-description">
              {t('meshcore.automation.delete_distance.threshold_description', 'Nodes farther than this from the home point are purged.')}
            </span>
          </label>
          <NumberInput
            id="mcDeleteDistanceThreshold"
            min={1}
            max={isMiles ? 30000 : 50000}
            value={displayThreshold}
            onChange={(v) => update('thresholdKm', isMiles ? Math.round(milesToKm(v) * 10) / 10 : v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcDeleteDistanceInterval">
            {t('meshcore.automation.delete_distance.interval', 'Run interval (hours)')}
            <span className="setting-description">
              {t('meshcore.automation.delete_distance.interval_description', 'How often the purge runs (6–48 hours).')}
            </span>
          </label>
          <NumberInput
            id="mcDeleteDistanceInterval"
            min={6}
            max={48}
            integer
            value={settings.intervalHours}
            onChange={(v) => update('intervalHours', v)}
            disabled={disabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcDeleteDistanceLat">
            {t('meshcore.automation.delete_distance.home_lat', 'Home latitude')}
            <span className="setting-description">
              {t('meshcore.automation.delete_distance.home_description', 'Leave blank to use this source’s own node position.')}
            </span>
          </label>
          {/* A text input (not NumberInput) because the home coordinate is
              optional — an empty value means "use the source's own position"
              (#6224), which NumberInput cannot represent. */}
          <input
            id="mcDeleteDistanceLat"
            type="text"
            inputMode="decimal"
            className="setting-input"
            value={settings.lat ?? ''}
            onChange={(e) => update('lat', e.target.value.trim() === '' ? null : Number(e.target.value))}
            disabled={disabled}
          />
        </div>

        <div className="setting-item">
          <label htmlFor="mcDeleteDistanceLon">
            {t('meshcore.automation.delete_distance.home_lon', 'Home longitude')}
          </label>
          <input
            id="mcDeleteDistanceLon"
            type="text"
            inputMode="decimal"
            className="setting-input"
            value={settings.lon ?? ''}
            onChange={(e) => update('lon', e.target.value.trim() === '' ? null : Number(e.target.value))}
            disabled={disabled}
          />
        </div>

        <div className="setting-item" style={{ alignItems: 'center' }}>
          <span className="setting-description">
            {running
              ? t('meshcore.automation.delete_distance.scheduler_on', 'Scheduler is active for this source.')
              : t('meshcore.automation.delete_distance.scheduler_off', 'Scheduler is not running for this source.')}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => { void handleRunNow(); }}
            disabled={!canWrite || isRunningNow}
          >
            {isRunningNow
              ? t('meshcore.automation.delete_distance.running', 'Running…')
              : t('meshcore.automation.delete_distance.run_now', 'Run now')}
          </button>
        </div>
      </ConfigSection>
    </NumberInputScope>
  );
};
