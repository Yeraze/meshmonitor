import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoKeyManagementSectionProps {
  enabled: boolean;
  intervalMinutes: number;
  maxExchanges: number;
  autoPurge: boolean;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onIntervalChange: (minutes: number) => void;
  onMaxExchangesChange: (count: number) => void;
  onAutoPurgeChange: (enabled: boolean) => void;
}

interface KeyRepairLogEntry {
  id: number;
  timestamp: number;
  nodeNum: number;
  nodeName: string | null;
  action: string;
  success: boolean | null;
}

const AutoKeyManagementSection: React.FC<AutoKeyManagementSectionProps> = ({
  enabled,
  intervalMinutes,
  maxExchanges,
  autoPurge,
  baseUrl,
  onEnabledChange,
  onIntervalChange,
  onMaxExchangesChange,
  onAutoPurgeChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localInterval, setLocalInterval] = useState(intervalMinutes || 5);
  const [localMaxExchanges, setLocalMaxExchanges] = useState(maxExchanges || 3);
  const [localAutoPurge, setLocalAutoPurge] = useState(autoPurge);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [repairLog, setRepairLog] = useState<KeyRepairLogEntry[]>([]);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalInterval(intervalMinutes || 5);
    setLocalMaxExchanges(maxExchanges || 3);
    setLocalAutoPurge(autoPurge);
  }, [enabled, intervalMinutes, maxExchanges, autoPurge]);

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localEnabled !== enabled ||
      localInterval !== intervalMinutes ||
      localMaxExchanges !== maxExchanges ||
      localAutoPurge !== autoPurge;
    setHasChanges(changed);
  }, [localEnabled, localInterval, localMaxExchanges, localAutoPurge, enabled, intervalMinutes, maxExchanges, autoPurge]);

  // Fetch repair log
  useEffect(() => {
    const fetchLog = async () => {
      try {
        const response = await csrfFetch(`${baseUrl}/api/settings/key-repair-log`);
        if (response.ok) {
          const data = await response.json();
          setRepairLog(data.log || []);
        }
      } catch (error) {
        console.error('Failed to fetch key repair log:', error);
      }
    };

    fetchLog();
    // Refresh log every 30 seconds
    const interval = setInterval(fetchLog, 30000);
    return () => clearInterval(interval);
  }, [baseUrl, csrfFetch]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoKeyManagementEnabled: String(localEnabled),
          autoKeyManagementIntervalMinutes: String(localInterval),
          autoKeyManagementMaxExchanges: String(localMaxExchanges),
          autoKeyManagementAutoPurge: String(localAutoPurge),
        }),
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Update parent state after successful API call
      onEnabledChange(localEnabled);
      onIntervalChange(localInterval);
      onMaxExchangesChange(localMaxExchanges);
      onAutoPurgeChange(localAutoPurge);

      setHasChanges(false);
      showToast(t('automation.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto key management settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const getActionIcon = (action: string, success: boolean | null): string => {
    switch (action) {
      case 'exchange':
        return success === null ? '\u23f3' : success ? '\u2705' : '\u274c'; // hourglass, checkmark, x
      case 'purge':
        return success ? '\ud83d\uddd1\ufe0f' : '\u274c'; // wastebasket, x
      case 'fixed':
        return '\u2705'; // checkmark
      case 'exhausted':
        return '\u26a0\ufe0f'; // warning
      default:
        return '?';
    }
  };

  const getActionLabel = (action: string): string => {
    switch (action) {
      case 'exchange':
        return t('automation.auto_key_management.action_exchange');
      case 'purge':
        return t('automation.auto_key_management.action_purge');
      case 'fixed':
        return t('automation.auto_key_management.action_fixed');
      case 'exhausted':
        return t('automation.auto_key_management.action_exhausted');
      default:
        return action;
    }
  };

  return (
    <>
      <div
        className="automation-section-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: '1.5rem',
          padding: '1rem 1.25rem',
          background: 'var(--ctp-surface1)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '8px',
        }}
      >
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          {t('automation.auto_key_management.title')}
          <a
            href="https://meshmonitor.org/features/automation#auto-key-management"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem',
            }}
            title={t('automation.view_docs')}
          >
            ?
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: hasChanges ? 1 : 0.5,
              cursor: hasChanges ? 'pointer' : 'not-allowed',
            }}
          >
            {isSaving ? t('automation.saving') : t('automation.save_changes')}
          </button>
        </div>
      </div>

      <div
        className="settings-section"
        style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}
      >
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5' }}>
          {t('automation.auto_key_management.description')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="keyRepairInterval">
            {t('automation.auto_key_management.interval_minutes')}
            <span className="setting-description">
              {t('automation.auto_key_management.interval_description')}
            </span>
          </label>
          <input
            id="keyRepairInterval"
            type="number"
            min="1"
            max="60"
            value={localInterval}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              if (value >= 1 && value <= 60) {
                setLocalInterval(value);
              }
            }}
            disabled={!localEnabled}
            className="setting-input"
            style={{ width: '100px' }}
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="maxExchanges">
            {t('automation.auto_key_management.max_exchanges')}
            <span className="setting-description">
              {t('automation.auto_key_management.max_exchanges_description')}
            </span>
          </label>
          <input
            id="maxExchanges"
            type="number"
            min="1"
            max="10"
            value={localMaxExchanges}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              if (value >= 1 && value <= 10) {
                setLocalMaxExchanges(value);
              }
            }}
            disabled={!localEnabled}
            className="setting-input"
            style={{ width: '100px' }}
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoPurge">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                id="autoPurge"
                type="checkbox"
                checked={localAutoPurge}
                onChange={(e) => setLocalAutoPurge(e.target.checked)}
                disabled={!localEnabled}
                style={{
                  width: 'auto',
                  margin: 0,
                  cursor: localEnabled ? 'pointer' : 'not-allowed',
                }}
              />
              {t('automation.auto_key_management.auto_purge')}
            </div>
            <span className="setting-description">
              {t('automation.auto_key_management.auto_purge_description')}
            </span>
          </label>
        </div>

        {/* Activity Log */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>{t('automation.auto_key_management.activity_log')}</label>
          <div
            style={{
              background: 'var(--ctp-surface0)',
              border: '1px solid var(--ctp-surface2)',
              borderRadius: '4px',
              maxHeight: '250px',
              overflow: 'auto',
              marginTop: '0.5rem',
            }}
          >
            {repairLog.length === 0 ? (
              <div
                style={{
                  padding: '1rem',
                  textAlign: 'center',
                  color: 'var(--ctp-subtext0)',
                }}
              >
                {t('automation.auto_key_management.no_activity')}
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'var(--ctp-surface1)' }}>
                    <th
                      style={{
                        padding: '0.5rem 0.75rem',
                        textAlign: 'left',
                        fontWeight: 500,
                      }}
                    >
                      {t('automation.auto_key_management.log_time')}
                    </th>
                    <th
                      style={{
                        padding: '0.5rem 0.75rem',
                        textAlign: 'left',
                        fontWeight: 500,
                      }}
                    >
                      {t('automation.auto_key_management.log_node')}
                    </th>
                    <th
                      style={{
                        padding: '0.5rem 0.75rem',
                        textAlign: 'left',
                        fontWeight: 500,
                      }}
                    >
                      {t('automation.auto_key_management.log_action')}
                    </th>
                    <th
                      style={{
                        padding: '0.5rem 0.75rem',
                        textAlign: 'center',
                        fontWeight: 500,
                      }}
                    >
                      {t('automation.auto_key_management.log_status')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {repairLog.map((entry) => (
                    <tr key={entry.id} style={{ borderTop: '1px solid var(--ctp-surface1)' }}>
                      <td style={{ padding: '0.4rem 0.75rem', color: 'var(--ctp-subtext0)' }}>
                        {new Date(entry.timestamp).toLocaleString()}
                      </td>
                      <td style={{ padding: '0.4rem 0.75rem' }}>
                        {entry.nodeName || `!${entry.nodeNum.toString(16).padStart(8, '0')}`}
                      </td>
                      <td style={{ padding: '0.4rem 0.75rem' }}>{getActionLabel(entry.action)}</td>
                      <td style={{ padding: '0.4rem 0.75rem', textAlign: 'center' }}>
                        {getActionIcon(entry.action, entry.success)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default AutoKeyManagementSection;
