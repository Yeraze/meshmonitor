import React, { useState, useEffect } from 'react';

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
  const [localInterval, setLocalInterval] = useState(intervalMinutes);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setLocalInterval(intervalMinutes);
  }, [intervalMinutes]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localInterval !== intervalMinutes;
    setHasChanges(changed);
  }, [localInterval, intervalMinutes]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Sync to backend first
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracerouteIntervalMinutes: localInterval
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      // Only update parent state after successful API call
      onIntervalChange(localInterval);

      setHasChanges(false);
      alert('Settings saved! Container restart required for changes to take effect.');
    } catch (error) {
      console.error('Failed to save auto-traceroute settings:', error);
      alert('Failed to save settings. Please try again.');
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
        <h2 style={{ margin: 0 }}>Auto Traceroute</h2>
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

      <div className="settings-section">
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5' }}>
          Automatically send traceroute requests to all active nodes at the configured interval.
          This helps maintain up-to-date network topology information. Set to 0 to disable.
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="tracerouteInterval">
            Traceroute Interval (minutes)
            <span className="setting-description">
              How often to automatically send traceroutes to nodes (0 = disabled). Requires container restart to take effect.
            </span>
          </label>
          <input
            id="tracerouteInterval"
            type="number"
            min="0"
            max="60"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value))}
            className="setting-input"
          />
        </div>
      </div>
    </>
  );
};

export default AutoTracerouteSection;
