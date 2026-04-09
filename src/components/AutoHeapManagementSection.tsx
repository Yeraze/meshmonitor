import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSaveBar } from '../hooks/useSaveBar';
import { useToast } from './ToastContainer';
import { useData } from '../contexts/DataContext';

interface AutoHeapManagementSectionProps {
  baseUrl: string;
}

const AutoHeapManagementSection: React.FC<AutoHeapManagementSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const { currentNodeId } = useData();

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

  const fetchHeapStatus = useCallback(async () => {
    if (!currentNodeId) return;
    try {
      const res = await csrfFetch(`${baseUrl}/api/v1/telemetry/${currentNodeId}?type=heapFreeBytes&limit=1`);
      if (res.ok) {
        const data = await res.json();
        const items = data.telemetry || data.items || data;
        if (Array.isArray(items) && items.length > 0) {
          setHeapFreeBytes(items[0].value);
        }
      }
    } catch (error) {
      console.error('Failed to fetch heap telemetry:', error);
    }
  }, [baseUrl, csrfFetch, currentNodeId]);

  useEffect(() => {
    fetchSettings();
    fetchHeapStatus();
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
          {t('automation.auto_heap.title', 'Auto Heap Management')}
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        {/* Warning callout */}
        <div style={{
          marginLeft: '1.75rem',
          marginBottom: '1rem',
          padding: '0.75rem 1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-yellow)',
          borderLeft: '4px solid var(--ctp-yellow)',
          borderRadius: '6px',
          color: 'var(--ctp-yellow)',
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
            background: 'var(--ctp-surface0)',
            border: '1px solid var(--ctp-surface2)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--ctp-subtext1)',
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
