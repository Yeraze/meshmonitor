import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import { useToast } from './ToastContainer';
import { useData } from '../contexts/DataContext';
import { useSource } from '../contexts/SourceContext';

/** Row shape of the session-authed GET /api/telemetry/:nodeId. */
interface TelemetryRow {
  telemetryType: string;
  timestamp: number;
  value: number;
}

/**
 * How far back to look for the node's last heap report. LocalStats arrive on
 * the device telemetry interval (30 min by default), so one hour can miss it.
 */
const HEAP_LOOKBACK_HOURS = 24;

interface AutoHeapManagementSectionProps {
  baseUrl: string;
}

const AutoHeapManagementSection: React.FC<AutoHeapManagementSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const { currentNodeId } = useData();
  const { sourceId } = useSource();

  const [localEnabled, setLocalEnabled] = useState(false);
  const [localThresholdKb, setLocalThresholdKb] = useState(20); // displayed as KB
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [initialSettings, setInitialSettings] = useState<{ enabled: boolean; thresholdKb: number } | null>(null);
  const [heapFreeBytes, setHeapFreeBytes] = useState<number | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`);
      if (res.ok) {
        const settings = await res.json();
        const enabled = settings.autoHeapManagementEnabled === 'true';
        const thresholdBytes = parseInt(settings.autoHeapManagementThresholdBytes || '20000');
        const thresholdKb = Math.round(thresholdBytes / 1000);
        setLocalEnabled(enabled);
        setLocalThresholdKb(thresholdKb);
        setInitialSettings({ enabled, thresholdKb });
      }
    } catch (error) {
      console.error('Failed to fetch auto heap management settings:', error);
    }
  }, [baseUrl, csrfFetch]);

  // Reads the session-authed internal endpoint, as the Info tab does. This used
  // to call /api/v1/telemetry, the bearer-token API, which answers a browser
  // session with 401, so the heap readout never appeared and every visit to the
  // Automation page logged a failed request.
  const fetchHeapStatus = useCallback(async () => {
    if (!currentNodeId || !sourceId) return;
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/telemetry/${encodeURIComponent(currentNodeId)}?hours=${HEAP_LOOKBACK_HOURS}&sourceId=${encodeURIComponent(sourceId)}`,
      );
      if (!res.ok) return;
      const rows: unknown = await res.json();
      if (!Array.isArray(rows)) return;
      let latest: TelemetryRow | null = null;
      for (const row of rows as TelemetryRow[]) {
        if (row?.telemetryType !== 'heapFreeBytes') continue;
        if (!latest || row.timestamp > latest.timestamp) latest = row;
      }
      if (latest) setHeapFreeBytes(latest.value);
    } catch (error) {
      console.error('Failed to fetch heap telemetry:', error);
    }
  }, [baseUrl, csrfFetch, currentNodeId, sourceId]);

  useEffect(() => {
    void fetchSettings();
    void fetchHeapStatus();
  }, [fetchSettings, fetchHeapStatus]);

  useEffect(() => {
    if (!initialSettings) return;
    setHasChanges(
      localEnabled !== initialSettings.enabled ||
      localThresholdKb !== initialSettings.thresholdKb
    );
  }, [localEnabled, localThresholdKb, initialSettings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoHeapManagementEnabled: localEnabled ? 'true' : 'false',
          autoHeapManagementThresholdBytes: String(localThresholdKb * 1000),
        }),
      });
      if (response.ok) {
        setInitialSettings({ enabled: localEnabled, thresholdKb: localThresholdKb });
        setHasChanges(false);
        showToast(t('automation.auto_heap.saved', 'Auto Heap Management settings saved'), 'success');
      } else {
        showToast(t('automation.auto_heap.save_error', 'Failed to save settings'), 'error');
      }
    } catch (error) {
      showToast(t('automation.auto_heap.save_error', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [baseUrl, csrfFetch, localEnabled, localThresholdKb, showToast, t]);

  const resetChanges = useCallback(() => {
    if (initialSettings) {
      setLocalEnabled(initialSettings.enabled);
      setLocalThresholdKb(initialSettings.thresholdKb);
    }
  }, [initialSettings]);

  useSaveBar({
    id: 'auto-heap-management',
    sectionName: t('automation.auto_heap.title', 'Auto Heap Management'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: resetChanges,
  });

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        padding: '1rem 1.25rem',
        background: 'var(--color-surface-hover)',
        border: '1px solid var(--color-surface-active)',
        borderRadius: '8px'
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.auto_heap.title', 'Auto Heap Management')}
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        {/* Warning callout */}
        <div style={{
          marginLeft: '1.75rem',
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-warning)',
          borderLeft: '4px solid var(--color-warning)',
          borderRadius: '6px',
          color: 'var(--color-warning)',
          fontSize: '13px',
          lineHeight: '1.5',
        }}>
          {t('automation.auto_heap.warning',
            'When triggered, MeshMonitor will remove the 10 least-recently-heard nodes from the device database and reboot the node. This may cause a brief disconnection.')}
        </div>

        {/* Heap status */}
        {heapFreeBytes !== null && (
          <div style={{
            marginLeft: '1.75rem',
            marginBottom: '1rem',
            padding: '0.5rem 1rem',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-surface-active)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--color-text-muted)',
          }}>
            {t('automation.auto_heap.heap_status', 'Current heap: {{kb}} KB free', {
              kb: Math.round(heapFreeBytes / 1000),
            })}
          </div>
        )}

        {/* Threshold input */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoHeapThresholdKb">
            {t('automation.auto_heap.threshold_label', 'Heap free threshold (KB)')}
            <span className="setting-description">
              {t('automation.auto_heap.threshold_hint',
                'Trigger a purge when the node reports less than this amount of free heap memory.')}
            </span>
          </label>
          <input
            id="autoHeapThresholdKb"
            type="number"
            min={1}
            max={500}
            value={localThresholdKb}
            onChange={(e) => setLocalThresholdKb(parseInt(e.target.value) || 20)}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>
      </div>
    </>
  );
};

export default AutoHeapManagementSection;
