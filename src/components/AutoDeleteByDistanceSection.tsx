import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
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
}

interface LogEntry {
  id: number;
  timestamp: number;
  nodes_deleted: number;
  threshold_km: number;
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
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { distanceUnit } = useSettings();

  // Local state for unsaved changes
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localIntervalHours, setLocalIntervalHours] = useState(intervalHours);
  const [localThresholdKm, setLocalThresholdKm] = useState(thresholdKm);
  const [localHomeLat, setLocalHomeLat] = useState<string>(homeLat != null ? String(homeLat) : '');
  const [localHomeLon, setLocalHomeLon] = useState<string>(homeLon != null ? String(homeLon) : '');

  // Activity log
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isMiles = distanceUnit === 'miles';

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

  // Detect unsaved changes
  const hasChanges =
    localEnabled !== enabled ||
    localIntervalHours !== intervalHours ||
    localThresholdKm !== thresholdKm ||
    (localHomeLat !== (homeLat != null ? String(homeLat) : '')) ||
    (localHomeLon !== (homeLon != null ? String(homeLon) : ''));

  // Fetch log entries
  const fetchLog = useCallback(async () => {
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/log`);
      if (response.ok) {
        const data = await response.json();
        setLogEntries(data);
      }
    } catch (error) {
      // Silently fail — log is not critical
    }
  }, [csrfFetch, baseUrl]);

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
      };

      const lat = parseFloat(localHomeLat);
      const lon = parseFloat(localHomeLon);
      if (!isNaN(lat)) settings.autoDeleteByDistanceLat = String(lat);
      if (!isNaN(lon)) settings.autoDeleteByDistanceLon = String(lon);

      const response = await csrfFetch(`${baseUrl}/api/settings`, {
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
    localEnabled, localIntervalHours, localThresholdKm, localHomeLat, localHomeLon,
    csrfFetch, baseUrl, onEnabledChange, onIntervalChange, onThresholdChange,
    onHomeLatChange, onHomeLonChange, showToast, t,
  ]);

  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalIntervalHours(intervalHours);
    setLocalThresholdKm(thresholdKm);
    setLocalHomeLat(homeLat != null ? String(homeLat) : '');
    setLocalHomeLon(homeLon != null ? String(homeLon) : '');
  }, [enabled, intervalHours, thresholdKm, homeLat, homeLon]);

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
      const response = await csrfFetch(`${baseUrl}/api/settings/distance-delete/run-now`, {
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
  }, [csrfFetch, baseUrl, showToast, t, fetchLog]);

  // Use Current Node Position
  const handleUseNodePosition = useCallback(() => {
    if (localNodeLat != null && localNodeLon != null) {
      setLocalHomeLat(String(localNodeLat));
      setLocalHomeLon(String(localNodeLon));
    }
  }, [localNodeLat, localNodeLon]);

  const unitLabel = isMiles ? 'mi' : 'km';

  return (
    <div className="settings-section">
      <h3>{t('automation.distance_delete.title')}</h3>
      <p className="text-muted">{t('automation.distance_delete.description')}</p>
      <p className="text-muted small">{t('automation.distance_delete.protected_note')}</p>

      {/* Enable toggle */}
      <div className="form-group">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
          />
          {t('automation.distance_delete.enabled')}
        </label>
      </div>

      {/* Home coordinate */}
      <div className="form-group">
        <label>{t('automation.distance_delete.home_coordinate')}</label>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="number"
            step="any"
            placeholder={t('automation.distance_delete.latitude')}
            value={localHomeLat}
            onChange={(e) => setLocalHomeLat(e.target.value)}
            style={{ width: '140px' }}
          />
          <input
            type="number"
            step="any"
            placeholder={t('automation.distance_delete.longitude')}
            value={localHomeLon}
            onChange={(e) => setLocalHomeLon(e.target.value)}
            style={{ width: '140px' }}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleUseNodePosition}
            disabled={localNodeLat == null || localNodeLon == null}
          >
            {t('automation.distance_delete.use_node_position')}
          </button>
        </div>
      </div>

      {/* Distance threshold */}
      <div className="form-group">
        <label>{t('automation.distance_delete.threshold')} ({unitLabel})</label>
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
          style={{ width: '120px' }}
        />
      </div>

      {/* Interval */}
      <div className="form-group">
        <label>{t('automation.distance_delete.interval')}</label>
        <select
          value={localIntervalHours}
          onChange={(e) => setLocalIntervalHours(parseInt(e.target.value, 10))}
        >
          {[6, 12, 24, 48].map((h) => (
            <option key={h} value={h}>
              {t('automation.distance_delete.interval_hours', { count: h })}
            </option>
          ))}
        </select>
      </div>

      {/* Run Now */}
      <div className="form-group">
        <button
          type="button"
          className="btn btn-warning"
          onClick={handleRunNow}
          disabled={isRunning || homeLat == null || homeLon == null}
        >
          {isRunning
            ? t('automation.distance_delete.running')
            : t('automation.distance_delete.run_now')}
        </button>
        {homeLat == null && (
          <span className="text-muted small" style={{ marginLeft: '8px' }}>
            {t('automation.distance_delete.no_home_coordinate')}
          </span>
        )}
      </div>

      {/* Activity Log */}
      <h4>{t('automation.distance_delete.activity_log')}</h4>
      {logEntries.length === 0 ? (
        <p className="text-muted">{t('automation.distance_delete.no_log_entries')}</p>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>{t('automation.distance_delete.timestamp', 'Time')}</th>
                <th>{t('automation.distance_delete.nodes_deleted')}</th>
                <th>{t('automation.distance_delete.threshold_used')} ({unitLabel})</th>
              </tr>
            </thead>
            <tbody>
              {logEntries.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.timestamp).toLocaleString()}</td>
                  <td>{entry.nodes_deleted}</td>
                  <td>{Math.round(toDisplayUnit(entry.threshold_km))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default AutoDeleteByDistanceSection;
