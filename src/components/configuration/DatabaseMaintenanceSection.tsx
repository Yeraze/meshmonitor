import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { logger } from '../../utils/logger';
import { useSaveBar } from '../../hooks/useSaveBar';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';

interface MaintenanceStats {
  messagesDeleted: number;
  traceroutesDeleted: number;
  routeSegmentsDeleted: number;
  neighborInfoDeleted: number;
  auditLogDeleted?: number;
  meshcoreCliHistoryDeleted?: number;
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
    auditLogRetentionDays: number;
    meshcoreCliHistoryRetentionDays?: number;
  };
}

/** Matches DEFAULT_AUDIT_LOG_RETENTION_DAYS on the server (#5870). */
const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 90;
/** Matches DEFAULT_MESHCORE_CLI_HISTORY_RETENTION_DAYS on the server (#5892). */
const DEFAULT_CLI_HISTORY_RETENTION_DAYS = 90;

const totalDeletedOf = (s: MaintenanceStats): number =>
  s.messagesDeleted + s.traceroutesDeleted + s.routeSegmentsDeleted + s.neighborInfoDeleted + (s.auditLogDeleted ?? 0) +
  (s.meshcoreCliHistoryDeleted ?? 0);

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
  const [auditLogRetentionDays, setAuditLogRetentionDays] = useState(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  const [cliHistoryRetentionDays, setCliHistoryRetentionDays] = useState(DEFAULT_CLI_HISTORY_RETENTION_DAYS);

  // Status state
  const [status, setStatus] = useState<MaintenanceStatus | null>(null);
  const [databaseSize, setDatabaseSize] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [saveCounter, setSaveCounter] = useState(0); // Triggers hasChanges recalculation

  // Track initial values loaded from API for change detection
  const initialValuesRef = useRef({
    enabled: false,
    maintenanceTime: '04:00',
    messageRetentionDays: 30,
    tracerouteRetentionDays: 30,
    routeSegmentRetentionDays: 30,
    neighborInfoRetentionDays: 30,
    auditLogRetentionDays: DEFAULT_AUDIT_LOG_RETENTION_DAYS,
    cliHistoryRetentionDays: DEFAULT_CLI_HISTORY_RETENTION_DAYS,
  });

  // Calculate if there are unsaved changes
  // saveCounter forces recalculation after save updates initialValuesRef
  const hasChanges = useMemo(() => {
    const initial = initialValuesRef.current;
    return (
      enabled !== initial.enabled ||
      maintenanceTime !== initial.maintenanceTime ||
      messageRetentionDays !== initial.messageRetentionDays ||
      tracerouteRetentionDays !== initial.tracerouteRetentionDays ||
      routeSegmentRetentionDays !== initial.routeSegmentRetentionDays ||
      neighborInfoRetentionDays !== initial.neighborInfoRetentionDays ||
      auditLogRetentionDays !== initial.auditLogRetentionDays ||
      cliHistoryRetentionDays !== initial.cliHistoryRetentionDays
    );
  }, [enabled, maintenanceTime, messageRetentionDays, tracerouteRetentionDays, routeSegmentRetentionDays, neighborInfoRetentionDays, auditLogRetentionDays, cliHistoryRetentionDays, saveCounter]);

  // Reset to initial values (for SaveBar dismiss)
  const resetChanges = useCallback(() => {
    const initial = initialValuesRef.current;
    setEnabled(initial.enabled);
    setMaintenanceTime(initial.maintenanceTime);
    setMessageRetentionDays(initial.messageRetentionDays);
    setTracerouteRetentionDays(initial.tracerouteRetentionDays);
    setRouteSegmentRetentionDays(initial.routeSegmentRetentionDays);
    setNeighborInfoRetentionDays(initial.neighborInfoRetentionDays);
    setAuditLogRetentionDays(initial.auditLogRetentionDays);
    setCliHistoryRetentionDays(initial.cliHistoryRetentionDays);
  }, []);

  // Maintenance runs on every backend (#5870); it used to be hidden on
  // PostgreSQL/MySQL, so those installs could never switch it on.
  useEffect(() => {
    void loadStatus();
    void loadDatabaseSize();
  }, []);

  const loadStatus = async () => {
    try {
      const data = await apiService.get<MaintenanceStatus>('/api/maintenance/status');
      setStatus(data);
      setEnabled(data.enabled);
      setMaintenanceTime(data.maintenanceTime);
      setMessageRetentionDays(data.settings.messageRetentionDays);
      setTracerouteRetentionDays(data.settings.tracerouteRetentionDays);
      setRouteSegmentRetentionDays(data.settings.routeSegmentRetentionDays);
      setNeighborInfoRetentionDays(data.settings.neighborInfoRetentionDays);
      setAuditLogRetentionDays(data.settings.auditLogRetentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS);
      setCliHistoryRetentionDays(data.settings.meshcoreCliHistoryRetentionDays ?? DEFAULT_CLI_HISTORY_RETENTION_DAYS);
      // Update initial values to match loaded settings
      initialValuesRef.current = {
        enabled: data.enabled,
        maintenanceTime: data.maintenanceTime,
        messageRetentionDays: data.settings.messageRetentionDays,
        tracerouteRetentionDays: data.settings.tracerouteRetentionDays,
        routeSegmentRetentionDays: data.settings.routeSegmentRetentionDays,
        neighborInfoRetentionDays: data.settings.neighborInfoRetentionDays,
        auditLogRetentionDays: data.settings.auditLogRetentionDays ?? DEFAULT_AUDIT_LOG_RETENTION_DAYS,
        cliHistoryRetentionDays: data.settings.meshcoreCliHistoryRetentionDays ?? DEFAULT_CLI_HISTORY_RETENTION_DAYS,
      };
    } catch (error) {
      // Preserve the prior silent-ignore on a non-ok HTTP response; only a
      // genuine network/transport failure gets logged.
      if (error instanceof ApiError) return;
      logger.error('Error loading maintenance status:', error);
    }
  };

  const loadDatabaseSize = async () => {
    try {
      const data = await apiService.get<{ size: number }>('/api/maintenance/size');
      setDatabaseSize(data.size);
    } catch (error) {
      // Preserve the prior silent-ignore on a non-ok HTTP response; only a
      // genuine network/transport failure gets logged.
      if (error instanceof ApiError) return;
      logger.error('Error loading database size:', error);
    }
  };

  const handleSaveSettings = async () => {
    try {
      setIsSaving(true);
      await apiService.post('/api/settings', {
        maintenanceEnabled: enabled ? 'true' : 'false',
        maintenanceTime,
        messageRetentionDays: String(messageRetentionDays),
        tracerouteRetentionDays: String(tracerouteRetentionDays),
        routeSegmentRetentionDays: String(routeSegmentRetentionDays),
        neighborInfoRetentionDays: String(neighborInfoRetentionDays),
        auditLogRetentionDays: String(auditLogRetentionDays),
        meshcoreCliHistoryRetentionDays: String(cliHistoryRetentionDays),
      });

      // Update initial values to match saved settings
      initialValuesRef.current = {
        enabled,
        maintenanceTime,
        messageRetentionDays,
        tracerouteRetentionDays,
        routeSegmentRetentionDays,
        neighborInfoRetentionDays,
        auditLogRetentionDays,
        cliHistoryRetentionDays,
      };
      // Trigger hasChanges recalculation
      setSaveCounter(c => c + 1);

      showToast(t('maintenance.toast_settings_saved'), 'success');
      void loadStatus();
    } catch (error) {
      logger.error('Error saving maintenance settings:', error);
      showToast(t('maintenance.toast_settings_failed', { error: error instanceof Error ? error.message : 'Unknown error' }), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Register with SaveBar. The scope blocks Save while a number field is blank (#5649).
  const numberScope = useNumberInputScope();
  useSaveBar({
    id: 'database-maintenance',
    sectionName: t('maintenance.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveSettings,
    onDismiss: resetChanges,
    numberScope
  });

  const handleRunNow = async () => {
    try {
      setIsRunning(true);
      showToast(t('maintenance.toast_running'), 'info');

      const result = await apiService.post<{ stats: MaintenanceStats }>('/api/maintenance/run');
      const stats = result.stats;
      const totalDeleted = totalDeletedOf(stats);
      const spaceSaved = stats.sizeBefore - stats.sizeAfter;

      showToast(
        t('maintenance.toast_complete', {
          count: totalDeleted,
          saved: formatBytes(spaceSaved)
        }),
        'success'
      );

      // Refresh status and size
      void loadStatus();
      void loadDatabaseSize();
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

  return (
    <NumberInputScope scope={numberScope}>
    <div id="settings-maintenance" className="settings-section" style={{ marginTop: '2rem' }}>
      <h3>{t('maintenance.title')}</h3>

      <div style={{
        backgroundColor: 'var(--color-surface)',
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1.5rem'
      }}>
        <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>{t('maintenance.about_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', margin: 0, fontSize: '0.9rem', lineHeight: '1.6' }}>
          {t('maintenance.about_description')}
        </p>
      </div>

      {/* Database Size */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('maintenance.database_size')}</h4>
        <p style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--color-accent)', margin: 0 }}>
          {databaseSize !== null ? formatBytes(databaseSize) : '...'}
        </p>
        {status?.lastRunStats && (
          <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {t('maintenance.last_run')}: {formatLastRun()}
            {status.lastRunStats && ` (${t('maintenance.deleted_records', { count: totalDeletedOf(status.lastRunStats) })})`}
          </p>
        )}
      </div>

      {/* Manual Run */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h4 style={{ marginBottom: '0.5rem' }}>{t('maintenance.manual_title')}</h4>
        <p style={{ color: 'var(--color-text-subtle)', marginBottom: '1rem', fontSize: '0.9rem' }}>
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
        <p style={{ color: 'var(--color-text-subtle)', marginBottom: '1rem', fontSize: '0.9rem' }}>
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
                    border: '1px solid var(--color-surface-active)',
                    backgroundColor: 'var(--color-surface)',
                    color: 'var(--color-text)',
                    fontSize: '1rem'
                  }}
                />
                <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
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
                  <NumberInput
                    value={messageRetentionDays}
                    onChange={setMessageRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.traceroute_retention')}
                  </label>
                  <NumberInput
                    value={tracerouteRetentionDays}
                    onChange={setTracerouteRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.routesegment_retention')}
                  </label>
                  <NumberInput
                    value={routeSegmentRetentionDays}
                    onChange={setRouteSegmentRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.neighborinfo_retention')}
                  </label>
                  <NumberInput
                    value={neighborInfoRetentionDays}
                    onChange={setNeighborInfoRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.auditlog_retention', 'Audit Log Retention')}
                  </label>
                  <NumberInput
                    value={auditLogRetentionDays}
                    onChange={setAuditLogRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                    {t('maintenance.meshcore_cli_history_retention', 'MeshCore CLI History Retention')}
                  </label>
                  <NumberInput
                    value={cliHistoryRetentionDays}
                    onChange={setCliHistoryRetentionDays}
                    min={7}
                    max={365}
                    integer
                    style={{
                      padding: '0.5rem',
                      borderRadius: '4px',
                      border: '1px solid var(--color-surface-active)',
                      backgroundColor: 'var(--color-surface)',
                      color: 'var(--color-text)',
                      fontSize: '1rem',
                      width: '100px'
                    }}
                  />
                  <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-subtle)' }}>{t('common.days')}</span>
                </div>
              </div>

              <p style={{ color: 'var(--color-text-subtle)', fontSize: '0.85rem', margin: 0 }}>
                {t('maintenance.retention_hint')}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
    </NumberInputScope>
  );
};

export default DatabaseMaintenanceSection;
