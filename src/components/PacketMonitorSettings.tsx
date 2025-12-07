import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

interface PacketMonitorSettingsProps {
  enabled: boolean;
  maxCount: number;
  maxAgeHours: number;
  onMaxCountChange: (count: number) => void;
  onMaxAgeHoursChange: (hours: number) => void;
}

const PacketMonitorSettings: React.FC<PacketMonitorSettingsProps> = ({
  enabled,
  maxCount,
  maxAgeHours,
  onMaxCountChange,
  onMaxAgeHoursChange
}) => {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();

  // Can only configure if user has settings:write permission
  const canWrite = hasPermission('settings', 'write');

  return (
    <div className="packet-monitor-settings-container">
      {!enabled && (
        <div className="setting-item">
          <p className="setting-description" style={{ color: 'var(--warning-color)', marginBottom: '1rem' }}>
            {t('packet_monitor.settings.disabled_warning')}
          </p>
        </div>
      )}

      <div className="setting-item">
        <label htmlFor="packet-max-count">
          {t('packet_monitor.settings.max_packets')}
          <span className="setting-description">
            {t('packet_monitor.settings.max_packets_desc')}
          </span>
        </label>
        <input
          id="packet-max-count"
          type="number"
          min="100"
          max="10000"
          step="100"
          value={maxCount}
          onChange={(e) => onMaxCountChange(parseInt(e.target.value, 10))}
          className="setting-input"
          disabled={!canWrite || !enabled}
        />
      </div>

      <div className="setting-item">
        <label htmlFor="packet-max-age">
          {t('packet_monitor.settings.keep_packets')}
          <span className="setting-description">
            {t('packet_monitor.settings.keep_packets_desc')}
          </span>
        </label>
        <input
          id="packet-max-age"
          type="number"
          min="1"
          max="168"
          value={maxAgeHours}
          onChange={(e) => onMaxAgeHoursChange(parseInt(e.target.value, 10))}
          className="setting-input"
          disabled={!canWrite || !enabled}
        />
      </div>

      <div className="packet-monitor-info">
        <p className="setting-description">
          <strong>{t('packet_monitor.settings.storage_estimate')}:</strong> {t('packet_monitor.settings.storage_value', { count: maxCount, size: Math.round(maxCount * 0.5 / 1024) })}
        </p>
        <p className="setting-description">
          <strong>{t('packet_monitor.settings.note')}:</strong> {t('packet_monitor.settings.cleanup_note')}
        </p>
      </div>

      {!canWrite && (
        <div className="packet-monitor-no-permission">
          <p className="setting-description" style={{ color: 'var(--warning-color)' }}>
            {t('packet_monitor.settings.no_permission')}
          </p>
        </div>
      )}
    </div>
  );
};

export default PacketMonitorSettings;
