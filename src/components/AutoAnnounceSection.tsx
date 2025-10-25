import React, { useState, useEffect, useRef } from 'react';

import { Channel } from '../types/device';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';

interface AutoAnnounceSectionProps {
  enabled: boolean;
  intervalHours: number;
  message: string;
  channelIndex: number;
  announceOnStart: boolean;
  channels: Channel[];
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onIntervalChange: (hours: number) => void;
  onMessageChange: (message: string) => void;
  onChannelChange: (channelIndex: number) => void;
  onAnnounceOnStartChange: (announceOnStart: boolean) => void;
}

const DEFAULT_MESSAGE = 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';

const AutoAnnounceSection: React.FC<AutoAnnounceSectionProps> = ({
  enabled,
  intervalHours,
  message,
  channelIndex,
  announceOnStart,
  channels,
  baseUrl,
  onEnabledChange,
  onIntervalChange,
  onMessageChange,
  onChannelChange,
  onAnnounceOnStartChange,
}) => {
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localInterval, setLocalInterval] = useState(intervalHours || 6);
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localChannelIndex, setLocalChannelIndex] = useState(channelIndex || 0);
  const [localAnnounceOnStart, setLocalAnnounceOnStart] = useState(announceOnStart);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSendingNow, setIsSendingNow] = useState(false);
  const [lastAnnouncementTime, setLastAnnouncementTime] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalInterval(intervalHours || 6);
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalChannelIndex(channelIndex || 0);
    setLocalAnnounceOnStart(announceOnStart);
  }, [enabled, intervalHours, message, channelIndex, announceOnStart]);

  // Fetch last announcement time
  useEffect(() => {
    const fetchLastAnnouncementTime = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/announce/last`);
        if (response.ok) {
          const data = await response.json();
          setLastAnnouncementTime(data.lastAnnouncementTime);
        }
      } catch (error) {
        console.error('Failed to fetch last announcement time:', error);
      }
    };

    fetchLastAnnouncementTime();
    // Refresh every 30 seconds
    const interval = setInterval(fetchLastAnnouncementTime, 30000);
    return () => clearInterval(interval);
  }, [baseUrl]);

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localEnabled !== enabled ||
      localInterval !== intervalHours ||
      localMessage !== message ||
      localChannelIndex !== channelIndex ||
      localAnnounceOnStart !== announceOnStart;
    setHasChanges(changed);
  }, [localEnabled, localInterval, localMessage, localChannelIndex, localAnnounceOnStart, enabled, intervalHours, message, channelIndex, announceOnStart]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Sync to backend first
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAnnounceEnabled: String(localEnabled),
          autoAnnounceIntervalHours: localInterval,
          autoAnnounceMessage: localMessage,
          autoAnnounceChannelIndex: localChannelIndex,
          autoAnnounceOnStart: String(localAnnounceOnStart)
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      // Only update parent state after successful API call
      onEnabledChange(localEnabled);
      onIntervalChange(localInterval);
      onMessageChange(localMessage);
      onChannelChange(localChannelIndex);
      onAnnounceOnStartChange(localAnnounceOnStart);

      setHasChanges(false);
      showToast('Settings saved! Container restart required for changes to take effect.', 'success');
    } catch (error) {
      console.error('Failed to save auto-announce settings:', error);
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
    sample = sample.replace(/{VERSION}/g, '2.9.1');
    sample = sample.replace(/{DURATION}/g, '3d 12h');

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

  const handleSendNow = async () => {
    setIsSendingNow(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/announce/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Server returned ${response.status}`);
      }

      const result = await response.json();
      showToast(result.message || 'Announcement sent successfully!', 'success');

      // Refresh last announcement time
      setLastAnnouncementTime(Date.now());
    } catch (error: any) {
      console.error('Failed to send announcement:', error);
      showToast(error.message || 'Failed to send announcement. Please try again.', 'error');
    } finally {
      setIsSendingNow(false);
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
          Auto Announce
          <a
            href="https://meshmonitor.org/features/automation#auto-announce"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '1.2rem',
              color: '#89b4fa',
              textDecoration: 'none',
              marginLeft: '0.5rem'
            }}
            title="View Auto Announce Documentation"
          >
            ❓
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleSendNow}
            disabled={isSendingNow || !localEnabled}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: (localEnabled && !isSendingNow) ? 1 : 0.5,
              cursor: (localEnabled && !isSendingNow) ? 'pointer' : 'not-allowed'
            }}
          >
            {isSendingNow ? 'Sending...' : 'Send Now'}
          </button>
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
          When enabled, automatically broadcast an announcement message to a selected channel at the configured interval.
          Use tokens like <code>{'{VERSION}'}</code>, <code>{'{DURATION}'}</code>, <code>{'{FEATURES}'}</code>, <code>{'{NODECOUNT}'}</code>, and <code>{'{DIRECTCOUNT}'}</code> for dynamic content.
          <strong> Requires container restart to take effect.</strong>
        </p>

        {lastAnnouncementTime && (
          <div style={{
            marginBottom: '1rem',
            padding: '0.75rem',
            background: 'var(--ctp-surface0)',
            border: '1px solid var(--ctp-surface2)',
            borderRadius: '4px',
            fontSize: '0.9rem',
            color: 'var(--ctp-subtext0)'
          }}>
            <strong>Last Announcement:</strong> {new Date(lastAnnouncementTime).toLocaleString()}
          </div>
        )}

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="announceOnStart">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                id="announceOnStart"
                type="checkbox"
                checked={localAnnounceOnStart}
                onChange={(e) => setLocalAnnounceOnStart(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              Announce on Start
            </div>
            <span className="setting-description">
              Automatically send an announcement when the container starts (includes 1-hour spam protection to avoid network flooding)
            </span>
          </label>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="announceInterval">
            Announcement Interval (hours)
            <span className="setting-description">
              How often to broadcast the announcement (3-24 hours). Default: 6 hours
            </span>
          </label>
          <input
            id="announceInterval"
            type="number"
            min="3"
            max="24"
            value={localInterval}
            onChange={(e) => setLocalInterval(parseInt(e.target.value))}
            disabled={!localEnabled}
            className="setting-input"
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="announceChannel">
            Broadcast Channel
            <span className="setting-description">
              Select which channel to broadcast announcements on
            </span>
          </label>
          <select
            id="announceChannel"
            value={localChannelIndex}
            onChange={(e) => setLocalChannelIndex(parseInt(e.target.value))}
            disabled={!localEnabled}
            className="setting-input"
          >
            {channels.map((channel, idx) => (
              <option key={channel.id} value={idx}>
                {channel.name || `Channel ${idx}`}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="announceMessage">
            Announcement Message
            <span className="setting-description">
              Message to broadcast. Available tokens: {'{VERSION}'} (MeshMonitor version), {'{DURATION}'} (uptime), {'{FEATURES}'} (enabled features as emojis), {'{NODECOUNT}'} (active nodes), {'{DIRECTCOUNT}'} (direct nodes at 0 hops)
            </span>
          </label>
          <textarea
            id="announceMessage"
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
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            Sample Message Preview
            <span className="setting-description">
              Shows how your announcement will appear after token substitution (using example values)
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

        <div style={{
          marginTop: '1rem',
          padding: '0.75rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '4px',
          fontSize: '0.9rem',
          color: 'var(--ctp-subtext0)'
        }}>
          <strong>Feature Emojis:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.5rem' }}>
            <li>🗺️ Auto Traceroute - Network topology mapping</li>
            <li>🤖 Auto Acknowledge - Automated message responses</li>
            <li>📢 Auto Announce - Periodic announcements</li>
          </ul>
        </div>
      </div>
    </>
  );
};

export default AutoAnnounceSection;
