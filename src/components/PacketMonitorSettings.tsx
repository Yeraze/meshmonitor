import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { NumberInput } from './common/NumberInput';

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

  // Can only configure if user has settings:write permission.
  // 'settings' is sourcey (Phase 6 #4416). This panel edits packetLogEnabled/
  // MaxCount/MaxAgeHours, which are not in PER_SOURCE_SETTINGS_KEYS — SettingsTab
  // always routes them into the unscoped globalBody POST (no sourceId query),
  // even inside a per-source context — so anySource mirrors the endpoint it
  // actually saves through.
  const canWrite = hasPermission('settings', 'write', { anySource: true });

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
        <NumberInput
          id="packet-max-count"
          min={100}
          max={10000}
          step={100}
          integer
          value={maxCount}
          onChange={onMaxCountChange}
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
        <NumberInput
          id="packet-max-age"
          min={1}
          max={168}
          integer
          value={maxAgeHours}
          onChange={onMaxAgeHoursChange}
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
