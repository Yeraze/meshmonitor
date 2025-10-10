import React, { useState, useEffect } from 'react';
import { useToast } from './ToastContainer';

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
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localRegex, setLocalRegex] = useState(regex || '^(test|ping)');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testMessages, setTestMessages] = useState('test\nTest message\nping\nPING\nHello world\nTESTING 123');

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || '^(test|ping)');
  }, [enabled, regex]);

  // Check if any settings have changed
  useEffect(() => {
    const changed = localEnabled !== enabled || localRegex !== regex;
    setHasChanges(changed);
  }, [localEnabled, localRegex, enabled, regex]);

  // Validate regex pattern for safety
  const validateRegex = (pattern: string): { valid: boolean; error?: string } => {
    // Check length
    if (pattern.length > 100) {
      return { valid: false, error: 'Pattern too long (max 100 characters)' };
    }

    // Check for potentially dangerous patterns
    if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
      return { valid: false, error: 'Pattern too complex or may cause performance issues' };
    }

    // Try to compile
    try {
      new RegExp(pattern, 'i');
      return { valid: true };
    } catch (error) {
      return { valid: false, error: 'Invalid regex syntax' };
    }
  };

  // Test if a message matches the regex (same logic as server)
  const testMessageMatch = (message: string): boolean => {
    if (!localRegex) return false;
    const validation = validateRegex(localRegex);
    if (!validation.valid) return false;

    try {
      const regex = new RegExp(localRegex, 'i');
      return regex.test(message);
    } catch (error) {
      // Invalid regex
      return false;
    }
  };

  const handleSave = async () => {
    // Validate regex before saving
    const validation = validateRegex(localRegex);
    if (!validation.valid) {
      showToast(`Invalid regex pattern: ${validation.error}`, 'error');
      return;
    }

    setIsSaving(true);
    try {
      // Sync to backend first
      const response = await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAckEnabled: String(localEnabled),
          autoAckRegex: localRegex
        }),
        credentials: 'include'
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast('Insufficient permissions to save settings', 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Only update parent state after successful API call (no localStorage)
      onEnabledChange(localEnabled);
      onRegexChange(localRegex);

      setHasChanges(false);
      showToast('Settings saved successfully!', 'success');
    } catch (error) {
      console.error('Failed to save auto-acknowledge settings:', error);
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
          Auto Acknowledge
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
          When enabled, automatically reply to any message matching the RegEx pattern with
          <strong> 🤖 Copy, N hops at T</strong> where <strong>N</strong> is the number of hops in the originating
          message, and <strong>T</strong> is the date/time the message was received.
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoAckRegex">
            Message Pattern (Regular Expression)
            <span className="setting-description">
              Messages matching this pattern will trigger an automatic acknowledgment.
              Pattern is case-insensitive. Default: <code>^(test|ping)</code>
            </span>
          </label>
          <input
            id="autoAckRegex"
            type="text"
            value={localRegex}
            onChange={(e) => setLocalRegex(e.target.value)}
            placeholder="^(test|ping)"
            disabled={!localEnabled}
            className="setting-input"
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="testMessages">
            Pattern Testing
            <span className="setting-description">
              Enter sample messages (one per line) to test your regex pattern.
              Green = will trigger auto-ack, Red = will not trigger
            </span>
          </label>
          <textarea
            id="testMessages"
            value={testMessages}
            onChange={(e) => setTestMessages(e.target.value)}
            placeholder="Enter test messages, one per line..."
            disabled={!localEnabled}
            className="setting-input"
            rows={6}
            style={{
              fontFamily: 'monospace',
              resize: 'vertical',
              minHeight: '120px'
            }}
          />
          <div style={{ marginTop: '0.75rem' }}>
            {testMessages.split('\n').filter(line => line.trim()).map((message, index) => {
              const matches = testMessageMatch(message);
              return (
                <div
                  key={index}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0.5rem',
                    marginBottom: '0.25rem',
                    backgroundColor: matches ? 'rgba(166, 227, 161, 0.1)' : 'rgba(243, 139, 168, 0.1)',
                    border: `1px solid ${matches ? 'var(--ctp-green)' : 'var(--ctp-red)'}`,
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    fontSize: '0.9rem'
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: matches ? 'var(--ctp-green)' : 'var(--ctp-red)',
                      marginRight: '0.75rem',
                      flexShrink: 0
                    }}
                  />
                  <span style={{ color: 'var(--ctp-text)', wordBreak: 'break-word' }}>
                    {message}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};

export default AutoAcknowledgeSection;
