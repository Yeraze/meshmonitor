import React, { useState, useEffect } from 'react';

interface AutoAcknowledgeSectionProps {
  enabled: boolean;
  regex: string;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onRegexChange: (regex: string) => void;
}

const AutoAcknowledgeSection: React.FC<AutoAcknowledgeSectionProps> = ({
  enabled,
  regex,
  baseUrl,
  onEnabledChange,
  onRegexChange,
}) => {
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localRegex, setLocalRegex] = useState(regex || 'test');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || 'test');
  }, [enabled, regex]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localEnabled !== enabled || localRegex !== regex;
    setHasChanges(changed);
  }, [localEnabled, localRegex, enabled, regex]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Update parent state
      onEnabledChange(localEnabled);
      onRegexChange(localRegex);

      // Save to localStorage
      localStorage.setItem('autoAckEnabled', String(localEnabled));
      localStorage.setItem('autoAckRegex', localRegex);

      // Sync to backend
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAckEnabled: String(localEnabled),
          autoAckRegex: localRegex
        })
      });

      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save auto-acknowledge settings:', error);
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
        <h2 style={{ margin: 0 }}>Automation</h2>
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
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={localEnabled}
            onChange={(e) => setLocalEnabled(e.target.checked)}
            style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
          />
          Auto Acknowledge
        </h3>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          When enabled, automatically reply to any message matching the RegEx pattern with
          <strong> 🤖 Copy, N hops at T</strong> where <strong>N</strong> is the number of hops in the originating
          message, and <strong>T</strong> is the date/time the message was received.
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoAckRegex">
            Message Pattern (Regular Expression)
            <span className="setting-description">
              Messages matching this pattern will trigger an automatic acknowledgment.
              Pattern is case-insensitive. Default: <code>test</code>
            </span>
          </label>
          <input
            id="autoAckRegex"
            type="text"
            value={localRegex}
            onChange={(e) => setLocalRegex(e.target.value)}
            placeholder="test"
            disabled={!localEnabled}
            className="setting-input"
            style={{ fontFamily: 'monospace' }}
          />
        </div>
      </div>
    </>
  );
};

export default AutoAcknowledgeSection;
