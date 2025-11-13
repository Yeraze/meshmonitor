import React, { useState, useEffect, useRef } from 'react';

import { Channel } from '../types/device';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoWelcomeSectionProps {
  enabled: boolean;
  message: string;
  target: string;
  waitForName: boolean;
  maxHops: number;
  channels: Channel[];
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onMessageChange: (message: string) => void;
  onTargetChange: (target: string) => void;
  onWaitForNameChange: (waitForName: boolean) => void;
  onMaxHopsChange: (maxHops: number) => void;
}

const DEFAULT_MESSAGE = 'Welcome {LONG_NAME} ({SHORT_NAME}) to the mesh!';

const AutoWelcomeSection: React.FC<AutoWelcomeSectionProps> = ({
  enabled,
  message,
  target,
  waitForName,
  maxHops,
  channels,
  baseUrl,
  onEnabledChange,
  onMessageChange,
  onTargetChange,
  onWaitForNameChange,
  onMaxHopsChange,
}) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localTarget, setLocalTarget] = useState(target || '0');
  const [localWaitForName, setLocalWaitForName] = useState(waitForName);
  const [localMaxHops, setLocalMaxHops] = useState(maxHops || 5);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalTarget(target || '0');
    setLocalWaitForName(waitForName);
    setLocalMaxHops(maxHops || 5);
  }, [enabled, message, target, waitForName, maxHops]);

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localEnabled !== enabled ||
      localMessage !== message ||
      localTarget !== target ||
      localWaitForName !== waitForName ||
      localMaxHops !== maxHops;
    setHasChanges(changed);
  }, [localEnabled, localMessage, localTarget, localWaitForName, localMaxHops, enabled, message, target, waitForName, maxHops]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Sync to backend first
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoWelcomeEnabled: String(localEnabled),
          autoWelcomeMessage: localMessage,
          autoWelcomeTarget: localTarget,
          autoWelcomeWaitForName: String(localWaitForName),
          autoWelcomeMaxHops: String(localMaxHops)
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
      onEnabledChange(localEnabled);
      onMessageChange(localMessage);
      onTargetChange(localTarget);
      onWaitForNameChange(localWaitForName);
      onMaxHopsChange(localMaxHops);

      setHasChanges(false);
      showToast('Settings saved successfully!', 'success');
    } catch (error) {
      console.error('Failed to save auto-welcome settings:', error);
      showToast('Failed to save settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
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
    sample = sample.replace(/{LONG_NAME}/g, 'Meshtastic ABC1');
    sample = sample.replace(/{SHORT_NAME}/g, 'ABC1');
    sample = sample.replace(/{VERSION}/g, '2.10.0');
    sample = sample.replace(/{DURATION}/g, '2d 5h');
    sample = sample.replace(/{FEATURES}/g, '🗺️ 🤖 📢');
    sample = sample.replace(/{NODECOUNT}/g, '15');
    sample = sample.replace(/{DIRECTCOUNT}/g, '3');

    return sample;
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
          Auto Welcome
          <a
            href="https://meshmonitor.org/features/automation#auto-welcome"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title="View Auto Welcome Documentation"
          >
            ❓
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
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
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5' }}>
          When enabled, automatically send a welcome message when a new node joins the mesh network.
          Use tokens to personalize messages: <code>{'{LONG_NAME}'}</code>, <code>{'{SHORT_NAME}'}</code>, <code>{'{VERSION}'}</code>, <code>{'{DURATION}'}</code>, <code>{'{FEATURES}'}</code>, <code>{'{NODECOUNT}'}</code>, <code>{'{DIRECTCOUNT}'}</code>
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="waitForName">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                id="waitForName"
                type="checkbox"
                checked={localWaitForName}
                onChange={(e) => setLocalWaitForName(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              Wait for Name
            </div>
            <span className="setting-description">
              Wait until the node has a Long Name or Short Name before sending the welcome message.
              If disabled, welcome messages will be sent immediately when a new node is discovered.
            </span>
          </label>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="maxHops">
            Maximum Hops
            <span className="setting-description">
              Only welcome nodes within this many hops (1-10). Nodes further away will not receive a welcome message.
            </span>
          </label>
          <input
            id="maxHops"
            type="number"
            min="1"
            max="10"
            value={localMaxHops}
            onChange={(e) => {
              const value = parseInt(e.target.value);
              if (value >= 1 && value <= 10) {
                setLocalMaxHops(value);
              }
            }}
            disabled={!localEnabled}
            className="setting-input"
            style={{ width: '100px' }}
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="welcomeTarget">
            Broadcast Target
            <span className="setting-description">
              Select where to send the welcome message
            </span>
          </label>
          <select
            id="welcomeTarget"
            value={localTarget}
            onChange={(e) => setLocalTarget(e.target.value)}
            disabled={!localEnabled}
            className="setting-input"
          >
            <option value="dm">Direct Message to New Node</option>
            {channels.map((channel, idx) => (
              <option key={channel.id} value={String(idx)}>
                {channel.name || `Channel ${idx}`}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="welcomeMessage">
            Welcome Message
            <span className="setting-description">
              Message to send to new nodes. Available tokens: {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}
            </span>
          </label>
          <textarea
            id="welcomeMessage"
            ref={textareaRef}
            value={localMessage}
            onChange={(e) => setLocalMessage(e.target.value)}
            disabled={!localEnabled}
            className="setting-input"
            rows={4}
            style={{
              fontFamily: 'monospace',
              resize: 'vertical',
              minHeight: '80px'
            }}
          />
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {[
              '{LONG_NAME}',
              '{SHORT_NAME}',
              '{VERSION}',
              '{DURATION}',
              '{FEATURES}',
              '{NODECOUNT}',
              '{DIRECTCOUNT}'
            ].map(token => (
              <button
                key={token}
                type="button"
                onClick={() => insertToken(token)}
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
                + {token}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            Sample Message Preview
            <span className="setting-description">
              Shows how your welcome message will appear after token substitution (using example values)
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
      </div>
    </>
  );
};

export default AutoWelcomeSection;
