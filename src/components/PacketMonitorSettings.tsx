import React from 'react';
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
  const { hasPermission } = useAuth();

  // Can only configure if user has settings:write permission
  const canWrite = hasPermission('settings', 'write');

  return (
    <div className="packet-monitor-settings-container">
      {!enabled && (
        <div className="setting-item">
          <p className="setting-description" style={{ color: 'var(--warning-color)', marginBottom: '1rem' }}>
            ⚠️ Packet logging is currently disabled. No packets will be stored. Enable it in the section header above to start collecting packet data.
          </p>
        </div>
      )}

      <div className="setting-item">
        <label htmlFor="packet-max-count">
          Maximum Packets to Store
          <span className="setting-description">
            Oldest packets will be automatically deleted when this limit is reached (Range: 100-10,000)
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
          Keep Packets For (hours)
          <span className="setting-description">
            Packets older than this will be automatically deleted (Range: 1-168 hours / 1 week)
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
          <strong>Storage Estimate:</strong> {maxCount} packets ≈ {Math.round(maxCount * 0.5 / 1024)} MB
        </p>
        <p className="setting-description">
          <strong>Note:</strong> Automatic cleanup runs every 15 minutes to enforce these limits.
        </p>
      </div>

      {!canWrite && (
        <div className="packet-monitor-no-permission">
          <p className="setting-description" style={{ color: 'var(--warning-color)' }}>
            ⚠️ You need <strong>settings:write</strong> permission to modify packet monitor settings.
          </p>
        </div>
      )}
    </div>
  );
};

export default PacketMonitorSettings;
