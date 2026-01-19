import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';

interface MaintenanceStats {
  messagesDeleted: number;
  traceroutesDeleted: number;
  routeSegmentsDeleted: number;
  neighborInfoDeleted: number;
  sizeBefore: number;
  sizeAfter: number;
  duration: number;
  timestamp: string;
}

interface MaintenanceStatus {
  running: boolean;
  maintenanceInProgress: boolean;
  enabled: boolean;
  maintenanceTime: string;
  lastRunTime: number | null;
  lastRunStats: MaintenanceStats | null;
  nextScheduledRun: string | null;
  databaseType: 'sqlite' | 'postgres' | 'mysql';
  settings: {
    messageRetentionDays: number;
    tracerouteRetentionDays: number;
    routeSegmentRetentionDays: number;
    neighborInfoRetentionDays: number;
  };
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

const DatabaseMaintenanceSection: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();

  // Settings state
  const [enabled, setEnabled] = useState(false);
  const [maintenanceTime, setMaintenanceTime] = useState('04:00');
  const [messageRetentionDays, setMessageRetentionDays] = useState(30);
  const [tracerouteRetentionDays, setTracerouteRetentionDays] = useState(30);
  const [routeSegmentRetentionDays, setRouteSegmentRetentionDays] = useState(30);
  const [neighborInfoRetentionDays, setNeighborInfoRetentionDays] = useState(30);

  // Status state
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [databaseSize, setDatabaseSize] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [databaseType, setDatabaseType] = useState<'sqlite' | 'postgres' | 'mysql' | null>(null);

  // Fetch database type from health endpoint (public, no auth required)
  useEffect(() => {
    const fetchDatabaseType = async () => {
      try {
        const baseUrl = await apiService.getBaseUrl();
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          const data = await response.json();
          if (data.databaseType) {
            setDatabaseType(data.databaseType);
          }
        }
      } catch (error) {
        logger.error('Error fetching database type:', error);
      }
    };
    fetchDatabaseType();
  }, []);

  // Load status and settings on mount (only if SQLite)
  useEffect(() => {
    if (databaseType === 'sqlite') {
      loadStatus();
      loadDatabaseSize();
    }
  }, [databaseType]);

  const loadStatus = async () => {
    try {
      const baseUrl = await apiService.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/maintenance/status`, {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const data: MaintenanceStatus = await response.json();
        setStatus(data);
        setEnabled(data.enabled);
        setMaintenanceTime(data.maintenanceTime);
        setMessageRetentionDays(data.settings.messageRetentionDays);
        setTracerouteRetentionDays(data.settings.tracerouteRetentionDays);
        setRouteSegmentRetentionDays(data.settings.routeSegmentRetentionDays);
        setNeighborInfoRetentionDays(data.settings.neighborInfoRetentionDays);
      }
    } catch (error) {
      logger.error('Error loading maintenance status:', error);
    }
  };

  const loadDatabaseSize = async () => {
    try {
      const baseUrl = await apiService.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/maintenance/size`, {
        credentials: 'same-origin'
      });

      if (response.ok) {
        const data = await response.json();
        setDatabaseSize(data.size);
      }
    } catch (error) {
      logger.error('Error loading database size:', error);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setIsSaving(true);
      const baseUrl = await apiService.getBaseUrl();

      // Get CSRF token
      const csrfToken = sessionStorage.getItem('csrfToken');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({
          maintenanceEnabled: enabled ? 'true' : 'false',
          maintenanceTime,
          messageRetentionDays: String(messageRetentionDays),
          tracerouteRetentionDays: String(tracerouteRetentionDays),
          routeSegmentRetentionDays: String(routeSegmentRetentionDays),
          neighborInfoRetentionDays: String(neighborInfoRetentionDays)
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save maintenance settings');
      }

      showToast(t('maintenance.toast_settings_saved'), 'success');
      loadStatus();
    } catch (error) {
      logger.error('Error saving maintenance settings:', error);
      showToast(t('maintenance.toast_settings_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunNow = async () => {
    try {
      setIsRunning(true);
      showToast(t('maintenance.toast_running'), 'info');

      const baseUrl = await apiService.getBaseUrl();

      // Get CSRF token
      const csrfToken = sessionStorage.getItem('csrfToken');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${baseUrl}/api/maintenance/run`, {
        method: 'POST',
        headers,
        credentials: 'same-origin'
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to run maintenance');
      }

      const result = await response.json();
      const stats = result.stats;
      const totalDeleted = stats.messagesDeleted + stats.traceroutesDeleted +
                          stats.routeSegmentsDeleted + stats.neighborInfoDeleted;
      const spaceSaved = stats.sizeBefore - stats.sizeAfter;

      showToast(
        t('maintenance.toast_complete', {
          count: totalDeleted,
          saved: formatBytes(spaceSaved)
        }),
        'success'
      );

      // Refresh status and size
      loadStatus();
      loadDatabaseSize();
    } catch (error) {
      logger.error('Error running maintenance:', error);
      showToast(t('maintenance.toast_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsRunning(false);
    }
  };

  const formatLastRun = (): string => {
    if (!status?.lastRunStats?.timestamp) {
      return t('maintenance.never_run');
    }
    return new Date(status.lastRunStats.timestamp).toLocaleString();
  };

  const formatNextRun = (): string => {
    if (!status?.nextScheduledRun) {
      return t('maintenance.not_scheduled');
    }
    return new Date(status.nextScheduledRun).toLocaleString();
  };

  // Hide the entire section for PostgreSQL/MySQL - maintenance features are SQLite-specific
  // Also hide if we can't determine the database type yet
  if (databaseType !== 'sqlite') {
    return null;
  }

  return (
    <div id="settings-maintenance" className="settings-section" style={{ marginTop: '2rem' }}>
      <h3>{t('maintenance.title')}</h3>

      <div style={{
        backgroundColor: 'var(--ctp-surface0)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>{t('maintenance.about_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          {t('maintenance.about_description')}
        </p>
      </div>

      {/* Database Size */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('maintenance.database_size')}</h4>
        <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--ctp-blue)', margin: 0 }}>
          {databaseSize !== null ? formatBytes(databaseSize) : '...'}
        </p>
        {status?.lastRunStats && (
          <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {t('maintenance.last_run')}: {formatLastRun()}
            {status.lastRunStats && ` (${t('maintenance.deleted_records', { count:
              status.lastRunStats.messagesDeleted +
              status.lastRunStats.traceroutesDeleted +
              status.lastRunStats.routeSegmentsDeleted +
              status.lastRunStats.neighborInfoDeleted
            })})`}
          </p>
        )}
      </div>

      {/* Manual Run */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('maintenance.manual_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('maintenance.manual_description')}
        </p>
        <button
          className="save-button"
          onClick={handleRunNow}
          disabled={isRunning || status?.maintenanceInProgress}
        >
          {isRunning || status?.maintenanceInProgress
            ? t('maintenance.running')
            : t('maintenance.run_now')}
        </button>
      </div>

      {/* Automated Maintenance */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('maintenance.auto_title')}</h4>
        <p style={{ color: 'var(--ctp-subtext0)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {t('maintenance.auto_description')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: '20px', height: '20px', cursor: 'pointer' }}
            />
            <span>{t('maintenance.enable_auto')}</span>
          </label>

          {enabled && (
            <>
              <div>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                  {t('maintenance.maintenance_time')}
                </label>
                <input
                  type="time"
                  value={maintenanceTime}
                  onChange={(e) => setMaintenanceTime(e.target.value)}
                  style={{
                    padding: '0.5rem',
                    borderRadius: '4px',
                    border: '1px solid var(--ctp-surface2)',
                    backgroundColor: 'var(--ctp-surface0)',
                    color: 'var(--ctp-text)',
                    fontSize: '1rem'
                  }}
                />
                <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                  {t('maintenance.next_run')}: {formatNextRun()}
                </p>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                gap: '1rem'
              }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.message_retention')}
                  </label>
                  <input
                    type="number"
                    value={messageRetentionDays}
                    onChange={(e) => setMessageRetentionDays(parseInt(e.target.value) || 30)}
                    min="7"
                    max="365"
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--ctp-surface2)',
                      backgroundColor: 'var(--ctp-surface0)',
                      color: 'var(--ctp-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.traceroute_retention')}
                  </label>
                  <input
                    type="number"
                    value={tracerouteRetentionDays}
                    onChange={(e) => setTracerouteRetentionDays(parseInt(e.target.value) || 30)}
                    min="7"
                    max="365"
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--ctp-surface2)',
                      backgroundColor: 'var(--ctp-surface0)',
                      color: 'var(--ctp-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.routesegment_retention')}
                  </label>
                  <input
                    type="number"
                    value={routeSegmentRetentionDays}
                    onChange={(e) => setRouteSegmentRetentionDays(parseInt(e.target.value) || 30)}
                    min="7"
                    max="365"
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--ctp-surface2)',
                      backgroundColor: 'var(--ctp-surface0)',
                      color: 'var(--ctp-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.neighborinfo_retention')}
                  </label>
                  <input
                    type="number"
                    value={neighborInfoRetentionDays}
                    onChange={(e) => setNeighborInfoRetentionDays(parseInt(e.target.value) || 30)}
                    min="7"
                    max="365"
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--ctp-surface2)',
                      backgroundColor: 'var(--ctp-surface0)',
                      color: 'var(--ctp-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)' }}>{t('common.days')}</span>
                </div>
              </div>

              <p style={{ color: 'var(--ctp-subtext0)', fontSize: '0.85rem', margin: 0 }}>
                {t('maintenance.retention_hint')}
              </p>
            </>
          )}

          <div className="settings-buttons">
            <button
              className="save-button"
              onClick={handleSaveSettings}
              disabled={isSaving}
            >
              {isSaving ? t('common.saving') : t('maintenance.save_settings')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DatabaseMaintenanceSection;
