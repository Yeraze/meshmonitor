import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import { kmToMiles } from '../utils/distance';
import { useSettings } from '../contexts/SettingsContext';

interface AutoDeleteByDistanceSectionProps {
  enabled: boolean;
  intervalHours: number;
  thresholdKm: number;
  homeLat: number | null;
  homeLon: number | null;
  localNodeLat?: number;
  localNodeLon?: number;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onIntervalChange: (hours: number) => void;
  onThresholdChange: (km: number) => void;
  onHomeLatChange: (lat: number | null) => void;
  onHomeLonChange: (lon: number | null) => void;
  action: 'delete' | 'ignore';
  onActionChange: (action: 'delete' | 'ignore') => void;
}

interface LogEntry {
  id: number;
  timestamp: number;
  nodesDeleted: number;
  thresholdKm: number;
  details: Array<{ nodeId: string; nodeName: string; distanceKm: number }>;
}

const AutoDeleteByDistanceSection: React.FC<AutoDeleteByDistanceSectionProps> = ({
  enabled,
  intervalHours,
  thresholdKm,
  homeLat,
  homeLon,
  localNodeLat,
  localNodeLon,
  baseUrl,
  onEnabledChange,
  onIntervalChange,
  onThresholdChange,
  onHomeLatChange,
  onHomeLonChange,
  action,
  onActionChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const { distanceUnit } = useSettings();

  // Local state for unsaved changes
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localIntervalHours, setLocalIntervalHours] = useState(intervalHours);
  const [localThresholdKm, setLocalThresholdKm] = useState(thresholdKm);
  const [localHomeLat, setLocalHomeLat] = useState<string>(homeLat != null ? String(homeLat) : '');
  const [localHomeLon, setLocalHomeLon] = useState<string>(homeLon != null ? String(homeLon) : '');
  const [localAction, setLocalAction] = useState<'delete' | 'ignore'>(action);

  // Activity log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isMiles = distanceUnit === 'mi';

  // Convert km to display unit
  const toDisplayUnit = useCallback((km: number) => isMiles ? kmToMiles(km) : km, [isMiles]);
  const fromDisplayUnit = useCallback((val: number) => isMiles ? val / 0.621371 : val, [isMiles]);

  // Threshold in display unit
  const displayThreshold = Math.round(toDisplayUnit(localThresholdKm) * 10) / 10;

  // Sync local state when props change
  useEffect(() => { setLocalEnabled(enabled); }, [enabled]);
  useEffect(() => { setLocalIntervalHours(intervalHours); }, [intervalHours]);
  useEffect(() => { setLocalThresholdKm(thresholdKm); }, [thresholdKm]);
  useEffect(() => { setLocalHomeLat(homeLat != null ? String(homeLat) : ''); }, [homeLat]);
  useEffect(() => { setLocalHomeLon(homeLon != null ? String(homeLon) : ''); }, [homeLon]);
  useEffect(() => { setLocalAction(action); }, [action]);

  // Detect unsaved changes
  const hasChanges =
    localEnabled !== enabled ||
    localIntervalHours !== intervalHours ||
    localThresholdKm !== thresholdKm ||
    (localHomeLat !== (homeLat != null ? String(homeLat) : '')) ||
    (localHomeLon !== (homeLon != null ? String(homeLon) : '')) ||
    localAction !== action;

  // Fetch log entries
  const fetchLog = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/log${sourceQuery}`);
      if (response.ok) {
        const data = await response.json();
        setLogEntries(data);
      }
    } catch (error) {
      // Silently fail — log is not critical
    }
  }, [csrfFetch, baseUrl, sourceQuery]);

  // Reset log entries when the selected source changes so stale per-source
  // history doesn't briefly flash before the new fetch lands.
  useEffect(() => {
    setLogEntries([]);
  }, [sourceQuery]);

  useEffect(() => {
    fetchLog();
    pollRef.current = setInterval(fetchLog, 30_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLog]);

  // Save handler
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const settings: Record<string, string> = {
        autoDeleteByDistanceEnabled: String(localEnabled),
        autoDeleteByDistanceIntervalHours: String(localIntervalHours),
        autoDeleteByDistanceThresholdKm: String(localThresholdKm),
        autoDeleteByDistanceAction: localAction,
      };

      const lat = parseFloat(localHomeLat);
      const lon = parseFloat(localHomeLon);
      if (!isNaN(lat)) settings.autoDeleteByDistanceLat = String(lat);
      if (!isNaN(lon)) settings.autoDeleteByDistanceLon = String(lon);

      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        onEnabledChange(localEnabled);
        onIntervalChange(localIntervalHours);
        onThresholdChange(localThresholdKm);
        onHomeLatChange(!isNaN(lat) ? lat : null);
        onHomeLonChange(!isNaN(lon) ? lon : null);
        onActionChange(localAction);
        showToast(t('automation.settings_saved', 'Settings saved'), 'success');
      } else {
        const err = await response.json();
        showToast(err.error || t('automation.settings_save_failed', 'Failed to save'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed', 'Failed to save'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [
    localEnabled, localIntervalHours, localThresholdKm, localHomeLat, localHomeLon, localAction,
    csrfFetch, baseUrl, sourceQuery, onEnabledChange, onIntervalChange, onThresholdChange,
    onHomeLatChange, onHomeLonChange, onActionChange, showToast, t,
  ]);

  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalIntervalHours(intervalHours);
    setLocalThresholdKm(thresholdKm);
    setLocalHomeLat(homeLat != null ? String(homeLat) : '');
    setLocalHomeLon(homeLon != null ? String(homeLon) : '');
    setLocalAction(action);
  }, [enabled, intervalHours, thresholdKm, homeLat, homeLon, action]);

  useSaveBar({
    id: 'auto-delete-by-distance',
    sectionName: t('automation.distance_delete.title'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  // Run Now handler
  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/run-now${sourceQuery}`, {
        method: 'POST',
      });
      if (response.ok) {
        const result = await response.json();
        showToast(
          t('automation.distance_delete.run_result', { count: result.deletedCount }),
          result.deletedCount > 0 ? 'warning' : 'success'
        );
        fetchLog(); // Refresh log
      } else {
        showToast(t('automation.settings_save_failed'), 'error');
      }
    } catch {
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsRunning(false);
    }
  }, [csrfFetch, baseUrl, showToast, t, fetchLog, sourceQuery]);

  // Use Current Node Position
  const handleUseNodePosition = useCallback(() => {
    if (localNodeLat != null && localNodeLon != null) {
      setLocalHomeLat(String(localNodeLat));
      setLocalHomeLon(String(localNodeLon));
    }
  }, [localNodeLat, localNodeLon]);

  const unitLabel = isMiles ? 'mi' : 'km';

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
          {t('automation.distance_delete.title')}
          <a
            href="https://meshmonitor.org/features/automation#auto-delete-by-distance"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleRunNow}
            disabled={!localEnabled || isRunning || homeLat == null || homeLon == null}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: (localEnabled && !isRunning && homeLat != null) ? 1 : 0.5,
              cursor: (localEnabled && !isRunning && homeLat != null) ? 'pointer' : 'not-allowed'
            }}
          >
            {isRunning
              ? t('automation.distance_delete.running')
              : t('automation.distance_delete.run_now')}
          </button>
        </div>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.distance_delete.description')}
        </p>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem', fontSize: '12px' }}>
          {t('automation.distance_delete.protected_note')}
        </p>

        {/* Home coordinate */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.distance_delete.home_coordinate')}
          </label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="number"
              step="any"
              placeholder={t('automation.distance_delete.latitude')}
              value={localHomeLat}
              onChange={(e) => setLocalHomeLat(e.target.value)}
              disabled={!localEnabled}
              className="setting-input"
              style={{ width: '140px' }}
            />
            <input
              type="number"
              step="any"
              placeholder={t('automation.distance_delete.longitude')}
              value={localHomeLon}
              onChange={(e) => setLocalHomeLon(e.target.value)}
              disabled={!localEnabled}
              className="setting-input"
              style={{ width: '140px' }}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={handleUseNodePosition}
              disabled={!localEnabled || localNodeLat == null || localNodeLon == null}
            >
              {t('automation.distance_delete.use_node_position')}
            </button>
          </div>
        </div>

        {/* Distance threshold */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.distance_delete.threshold')} ({unitLabel})
          </label>
          <input
            type="number"
            min="1"
            step="1"
            value={Math.round(displayThreshold)}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) {
                setLocalThresholdKm(Math.round(fromDisplayUnit(val) * 10) / 10);
              }
            }}
            disabled={!localEnabled}
            className="setting-input"
            style={{ width: '120px' }}
          />
        </div>

        {/* Interval */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.distance_delete.interval')}
          </label>
          <select
            value={localIntervalHours}
            onChange={(e) => setLocalIntervalHours(parseInt(e.target.value, 10))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {[6, 12, 24, 48].map((h) => (
              <option key={h} value={h}>
                {t('automation.distance_delete.interval_hours', { count: h })}
              </option>
            ))}
          </select>
        </div>

        {/* Action toggle: Delete vs Ignore */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.distance_delete.action', 'Action for nodes beyond threshold')}
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', cursor: localEnabled ? 'pointer' : 'not-allowed' }}>
              <input
                type="radio"
                name="autoDeleteByDistanceAction"
                value="delete"
                checked={localAction === 'delete'}
                onChange={() => setLocalAction('delete')}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              {t('automation.distance_delete.action_delete', 'Delete node')}
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', cursor: localEnabled ? 'pointer' : 'not-allowed', marginLeft: '1rem' }}>
              <input
                type="radio"
                name="autoDeleteByDistanceAction"
                value="ignore"
                checked={localAction === 'ignore'}
                onChange={() => setLocalAction('ignore')}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              {t('automation.distance_delete.action_ignore', 'Ignore node')}
            </label>
          </div>
          <p style={{
            marginTop: '0.5rem',
            marginLeft: 0,
            padding: '0.5rem 0.75rem',
            background: 'var(--ctp-surface0)',
            border: '1px solid var(--ctp-surface2)',
            borderLeft: '3px solid var(--ctp-yellow)',
            borderRadius: '4px',
            color: 'var(--ctp-subtext1)',
            fontSize: '12px',
            lineHeight: '1.5',
          }}>
            {localAction === 'delete'
              ? t('automation.distance_delete.note_delete', 'A deleted node may return if it continues to broadcast. Choose Ignore to suppress it persistently on the device.')
              : t('automation.distance_delete.note_ignore', 'Ignored nodes are hidden and synced to the connected device (requires firmware ≥ 2.7.0).')}
          </p>
        </div>

        {homeLat == null && (
          <p style={{ marginTop: '1rem', marginLeft: '1.75rem', color: 'var(--ctp-yellow)', fontSize: '12px' }}>
            {t('automation.distance_delete.no_home_coordinate')}
          </p>
        )}

        {/* Activity Log */}
        <div style={{ marginTop: '2rem', marginLeft: '1.75rem' }}>
          <h3 style={{ marginBottom: '0.75rem' }}>
            {t('automation.distance_delete.activity_log')}
          </h3>
          {logEntries.length === 0 ? (
            <p className="text-muted">{t('automation.distance_delete.no_log_entries')}</p>
          ) : (
            <div style={{
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '6px',
              overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--ctp-surface0)' }}>
                    <th style={{ padding: '0.5rem', textAlign: 'left', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.distance_delete.timestamp', 'Time')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.distance_delete.nodes_deleted')}
                    </th>
                    <th style={{ padding: '0.5rem', textAlign: 'center', borderBottom: '1px solid var(--ctp-surface2)' }}>
                      {t('automation.distance_delete.threshold_used')} ({unitLabel})
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logEntries.map((entry) => (
                    <tr key={entry.id} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                      <td style={{ padding: '0.5rem' }}>
                        {new Date(Number(entry.timestamp)).toLocaleString()}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                        {entry.nodesDeleted}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>
                        {Math.round(toDisplayUnit(entry.thresholdKm))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AutoDeleteByDistanceSection;
