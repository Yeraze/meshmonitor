import React, { useState, useEffect, useRef } from 'react';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { Channel } from '../types/device';

interface AutoAcknowledgeSectionProps {
  enabled: boolean;
  regex: string;
  message: string;
  channels: Channel[];
  enabledChannels: number[];
  directMessagesEnabled: boolean;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onRegexChange: (regex: string) => void;
  onMessageChange: (message: string) => void;
  onChannelsChange: (channels: number[]) => void;
  onDirectMessagesChange: (enabled: boolean) => void;
}

const DEFAULT_MESSAGE = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';

const AutoAcknowledgeSection: React.FC<AutoAcknowledgeSectionProps> = ({
  enabled,
  regex,
  message,
  channels,
  enabledChannels,
  directMessagesEnabled,
  baseUrl,
  onEnabledChange,
  onRegexChange,
  onMessageChange,
  onChannelsChange,
  onDirectMessagesChange,
}) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localRegex, setLocalRegex] = useState(regex || '^(test|ping)');
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localEnabledChannels, setLocalEnabledChannels] = useState<number[]>(enabledChannels);
  const [localDirectMessagesEnabled, setLocalDirectMessagesEnabled] = useState(directMessagesEnabled);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testMessages, setTestMessages] = useState('test\nTest message\nping\nPING\nHello world\nTESTING 123');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || '^(test|ping)');
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalEnabledChannels(enabledChannels);
    setLocalDirectMessagesEnabled(directMessagesEnabled);
  }, [enabled, regex, message, enabledChannels, directMessagesEnabled]);

  // Check if any settings have changed
  useEffect(() => {
    const channelsChanged = JSON.stringify(localEnabledChannels.sort()) !== JSON.stringify(enabledChannels.sort());
    const changed = localEnabled !== enabled || localRegex !== regex || localMessage !== message || channelsChanged || localDirectMessagesEnabled !== directMessagesEnabled;
    setHasChanges(changed);
  }, [localEnabled, localRegex, localMessage, localEnabledChannels, localDirectMessagesEnabled, enabled, regex, message, enabledChannels, directMessagesEnabled]);

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

  const insertToken = (token: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      // Fallback: append to end if textarea ref not available
      setLocalMessage(localMessage + token);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newMessage = localMessage.substring(0, start) + token + localMessage.substring(end);

    setLocalMessage(newMessage);

    // Set cursor position after the inserted token
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };

  // Generate sample message with example token values
  const generateSampleMessage = (): string => {
    let sample = localMessage;

    // Replace with sample values
    sample = sample.replace(/{NODE_ID}/g, '!a1b2c3d4');
    sample = sample.replace(/{NUMBER_HOPS}/g, '3');
    sample = sample.replace(/{RABBIT_HOPS}/g, '🐇🐇🐇'); // 3 rabbits for 3 hops
    sample = sample.replace(/{TIME}/g, new Date().toLocaleString());
    sample = sample.replace(/{VERSION}/g, '2.9.1');
    sample = sample.replace(/{DURATION}/g, '3d 12h');
    sample = sample.replace(/{LONG_NAME}/g, 'Meshtastic ABC1');
    sample = sample.replace(/{SHORT_NAME}/g, 'ABC1');

    // Check which features would be shown
    const sampleFeatures: string[] = [];
    sampleFeatures.push('🗺️'); // Traceroute
    sampleFeatures.push('🤖'); // Auto-ack
    sampleFeatures.push('📢'); // Auto-announce
    sample = sample.replace(/{FEATURES}/g, sampleFeatures.join(' '));

    sample = sample.replace(/{NODECOUNT}/g, '42');
    sample = sample.replace(/{DIRECTCOUNT}/g, '8');

    return sample;
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
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAckEnabled: String(localEnabled),
          autoAckRegex: localRegex,
          autoAckMessage: localMessage,
          autoAckChannels: localEnabledChannels.join(','),
          autoAckDirectMessages: String(localDirectMessagesEnabled)
        })
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
      onMessageChange(localMessage);
      onChannelsChange(localEnabledChannels);
      onDirectMessagesChange(localDirectMessagesEnabled);

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
      <div className="automation-section-header" style={{
        display: 'flex',
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
          <a
            href="https://meshmonitor.org/features/automation#auto-acknowledge"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title="View Auto Acknowledge Documentation"
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
          When enabled, automatically reply to any message matching the RegEx pattern with a customizable template.
          Use tokens like <code>{'{NODE_ID}'}</code>, <code>{'{NUMBER_HOPS}'}</code>, and <code>{'{TIME}'}</code> for dynamic content.
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
          <label>
            Active Channels
            <span className="setting-description">
              Select which channels and direct messages should have auto-acknowledge enabled
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="autoAckDM"
                checked={localDirectMessagesEnabled}
                onChange={(e) => setLocalDirectMessagesEnabled(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckDM" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                Direct Messages
              </label>
            </div>
            {channels.map((channel, idx) => (
              <div key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id={`autoAckChannel${idx}`}
                  checked={localEnabledChannels.includes(idx)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setLocalEnabledChannels([...localEnabledChannels, idx]);
                    } else {
                      setLocalEnabledChannels(localEnabledChannels.filter(c => c !== idx));
                    }
                  }}
                  disabled={!localEnabled}
                  style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
                />
                <label htmlFor={`autoAckChannel${idx}`} style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}>
                  {channel.name || `Channel ${idx}`}
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="autoAckMessage">
            Acknowledgment Message Template
            <span className="setting-description">
              Message to send in response. Available tokens: {'{NODE_ID}'} (sender node ID), {'{NUMBER_HOPS}'} (hop count), {'{RABBIT_HOPS}'} (rabbit emojis equal to hop count, 🎯 for direct/0 hops), {'{TIME}'} (current time), {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{LONG_NAME}'} (sender's long name), {'{SHORT_NAME}'} (sender's short name)
            </span>
          </label>
          <textarea
            id="autoAckMessage"
            ref={textareaRef}
            value={localMessage}
            onChange={(e) => setLocalMessage(e.target.value)}
            disabled={!localEnabled}
            className="setting-input"
            rows={3}
            style={{
              fontFamily: 'monospace',
              resize: 'vertical',
              minHeight: '60px'
            }}
          />
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => insertToken('{NODE_ID}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{NODE_ID}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{NUMBER_HOPS}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{NUMBER_HOPS}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{RABBIT_HOPS}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{RABBIT_HOPS}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{TIME}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{TIME}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{VERSION}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{VERSION}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{DURATION}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{DURATION}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{FEATURES}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{FEATURES}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{NODECOUNT}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{NODECOUNT}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{DIRECTCOUNT}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{DIRECTCOUNT}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{LONG_NAME}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{LONG_NAME}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{SHORT_NAME}')}
              disabled={!localEnabled}
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '12px',
                background: 'var(--ctp-surface2)',
                border: '1px solid var(--ctp-overlay0)',
                borderRadius: '4px',
                cursor: localEnabled ? 'pointer' : 'not-allowed',
                opacity: localEnabled ? 1 : 0.5
              }}
            >
              + {'{SHORT_NAME}'}
            </button>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            Sample Message Preview
            <span className="setting-description">
              Shows how your acknowledgment will appear after token substitution (using example values)
            </span>
          </label>
          <div style={{
            padding: '0.75rem',
            background: 'var(--ctp-surface0)',
            border: '2px solid var(--ctp-blue)',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '0.95rem',
            color: 'var(--ctp-text)',
            lineHeight: '1.5',
            minHeight: '50px'
          }}>
            {generateSampleMessage()}
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="testMessages">
            Pattern Testing
            <span className="setting-description">
              Enter sample messages (one per line) to test your regex pattern.
              Green = will trigger auto-ack, Red = will not trigger
            </span>
          </label>
          <div className="auto-ack-test-container">
            <div>
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
                  minHeight: '120px',
                  width: '100%'
                }}
              />
            </div>
            <div>
              {testMessages.split('\n').filter(line => line.trim()).map((message, index) => {
                const matches = testMessageMatch(message);
                return (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '0.25rem 0.5rem',
                      marginBottom: '0.15rem',
                      backgroundColor: matches ? 'rgba(166, 227, 161, 0.1)' : 'rgba(243, 139, 168, 0.1)',
                      border: `1px solid ${matches ? 'var(--ctp-green)' : 'var(--ctp-red)'}`,
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      fontSize: '0.9rem',
                      lineHeight: '1.3'
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        backgroundColor: matches ? 'var(--ctp-green)' : 'var(--ctp-red)',
                        marginRight: '0.5rem',
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
      </div>
    </>
  );
};

export default AutoAcknowledgeSection;
