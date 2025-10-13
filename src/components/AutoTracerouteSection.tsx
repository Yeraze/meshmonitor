import React, { useState, useEffect } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoTracerouteSectionProps {
  intervalMinutes: number;
  baseUrl: string;
  onIntervalChange: (minutes: number) => void;
}

const AutoTracerouteSection: React.FC<AutoTracerouteSectionProps> = ({
  intervalMinutes,
  baseUrl,
  onIntervalChange,
}) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(intervalMinutes > 0);
  const [localInterval, setLocalInterval] = useState(intervalMinutes > 0 ? intervalMinutes : 3);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(intervalMinutes > 0);
    setLocalInterval(intervalMinutes > 0 ? intervalMinutes : 3);
  }, [intervalMinutes]);

  // Check if any settings have changed
  useEffect(() => {
    const currentInterval = localEnabled ? localInterval : 0;
    const changed = currentInterval !== intervalMinutes;
    setHasChanges(changed);
  }, [localEnabled, localInterval, intervalMinutes]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const intervalToSave = localEnabled ? localInterval : 0;

      // Sync to backend first
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracerouteIntervalMinutes: intervalToSave
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast('Insufficient permissions to save settings', 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Only update parent state after successful API call
      onIntervalChange(intervalToSave);

      setHasChanges(false);
      showToast('Settings saved! Container restart required for changes to take effect.', 'success');
    } catch (error) {
      console.error('Failed to save auto-traceroute settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
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
          Auto Traceroute
          <a
            href="https://meshmonitor.org/features/automation#auto-traceroute"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title="View Auto Traceroute Documentation"
          >
            ❓
          </a>
        </h2>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="btn-primary"
          style={{
            padding: '0.5rem 1.5rem',
            fontSize: '14px',
            opacity: hasChanges ? 1 : 0.5,
            cursor: hasChanges ? 'pointer' : 'not-allowed'
          }}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          When enabled, automatically send traceroute requests to all active nodes at the configured interval.
          This helps maintain up-to-date network topology information. <strong>Requires container restart to take effect.</strong>
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="tracerouteInterval">
            Traceroute Interval (minutes)
            <span className="setting-description">
              How often to automatically send traceroutes to nodes. Default: 3 minutes
            </span>
          </label>
          <input
            id="tracerouteInterval"
            type="number"
            min="1"
            max="60"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value))}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>
      </div>
    </>
  );
};

export default AutoTracerouteSection;
