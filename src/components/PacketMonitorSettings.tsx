import React, { useState, useEffect } from 'react';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useToast } from './ToastContainer';
import { useAuth } from '../contexts/AuthContext';

interface PacketMonitorSettingsProps {
  baseUrl: string;
}

const PacketMonitorSettings: React.FC<PacketMonitorSettingsProps> = ({ baseUrl }) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [maxCount, setMaxCount] = useState(1000);
  const [maxAgeHours, setMaxAgeHours] = useState(24);
  const [hasChanges, setHasChanges] = useState(false);
  const [initialValues, setInitialValues] = useState({ enabled: false, maxCount: 1000, maxAgeHours: 24 });

  // Can only configure if user has settings:write permission
  const canWrite = hasPermission('settings', 'write');

  // Fetch current settings
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/settings`, {
          credentials: 'include'
        });
        if (response.ok) {
          const settings = await response.json();
          const enabledValue = settings.packet_log_enabled === '1';
          const maxCountValue = parseInt(settings.packet_log_max_count || '1000', 10);
          const maxAgeHoursValue = parseInt(settings.packet_log_max_age_hours || '24', 10);

          setEnabled(enabledValue);
          setMaxCount(maxCountValue);
          setMaxAgeHours(maxAgeHoursValue);
          setInitialValues({ enabled: enabledValue, maxCount: maxCountValue, maxAgeHours: maxAgeHoursValue });
        }
      } catch (error) {
        console.error('Failed to fetch packet monitor settings:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchSettings();
  }, [baseUrl]);

  // Track changes compared to initial values
  useEffect(() => {
    const changed = enabled !== initialValues.enabled ||
                    maxCount !== initialValues.maxCount ||
                    maxAgeHours !== initialValues.maxAgeHours;
    setHasChanges(changed);
  }, [enabled, maxCount, maxAgeHours, initialValues]);

  // Save settings
  const handleSave = async () => {
    if (!canWrite) {
      showToast('You do not have permission to change settings', 'error');
      return;
    }

    console.log('💾 Saving packet monitor settings:', { enabled, maxCount, maxAgeHours });

    setSaving(true);
    try {
      const payload = {
        packet_log_enabled: enabled ? '1' : '0',
        packet_log_max_count: maxCount.toString(),
        packet_log_max_age_hours: maxAgeHours.toString(),
      };
      console.log('📤 Sending payload:', payload);

      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        showToast('Packet monitor settings saved successfully', 'success');
        setHasChanges(false);
        // Update initial values after successful save
        setInitialValues({ enabled, maxCount, maxAgeHours });
      } else {
        throw new Error('Failed to save settings');
      }
    } catch (error) {
      console.error('Failed to save packet monitor settings:', error);
      showToast('Failed to save packet monitor settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="packet-monitor-settings-loading">Loading...</div>;
  }

  return (
    <div className="packet-monitor-settings-container">
      <div className="setting-item">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              console.log('✅ Checkbox changed to:', e.target.checked);
              setEnabled(e.target.checked);
            }}
            disabled={!canWrite}
          />
          <span style={{ marginLeft: '8px' }}>Enable Packet Logging</span>
        </label>
        <span className="setting-description">
          When enabled, all mesh packets will be logged to the database for viewing in the Packet Monitor panel.
          {!enabled && <span style={{ color: 'var(--warning-color)', display: 'block', marginTop: '4px' }}>
            ⚠️ Packet logging is currently disabled. No packets will be stored.
          </span>}
        </span>
      </div>

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
          onChange={(e) => setMaxCount(parseInt(e.target.value, 10))}
          className="setting-input"
          disabled={!canWrite}
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
          onChange={(e) => setMaxAgeHours(parseInt(e.target.value, 10))}
          className="setting-input"
          disabled={!canWrite}
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

      {canWrite && (
        <div className="packet-monitor-actions">
          <button
            className="save-button"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? 'Saving...' : 'Save Packet Monitor Settings'}
          </button>
        </div>
      )}

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
