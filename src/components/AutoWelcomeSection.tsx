import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Channel } from '../types/device';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';

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
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localTarget, setLocalTarget] = useState(target || '0');
  const [localWaitForName, setLocalWaitForName] = useState(waitForName);
  const [localMaxHops, setLocalMaxHops] = useState(maxHops || 5);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMarkingWelcomed, setIsMarkingWelcomed] = useState(false);
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

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalTarget(target || '0');
    setLocalWaitForName(waitForName);
    setLocalMaxHops(maxHops || 5);
  }, [enabled, message, target, waitForName, maxHops]);

  const handleMarkAllWelcomed = async () => {
    setIsMarkingWelcomed(true);
    try {
      const response = await csrfFetch(`${baseUrl}/api/settings/mark-all-welcomed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      showToast(t('automation.auto_welcome.marked_all_welcomed', { count: data.count }), 'success');
    } catch (error) {
      console.error('Failed to mark all nodes as welcomed:', error);
      showToast(t('automation.auto_welcome.mark_welcomed_failed'), 'error');
    } finally {
      setIsMarkingWelcomed(false);
    }
  };

  const handleSaveForSaveBar = useCallback(async () => {
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
          showToast(t('automation.insufficient_permissions'), 'error');
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
      showToast(t('automation.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-welcome settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localEnabled, localMessage, localTarget, localWaitForName, localMaxHops, baseUrl, csrfFetch, showToast, t, onEnabledChange, onMessageChange, onTargetChange, onWaitForNameChange, onMaxHopsChange]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-welcome',
    sectionName: t('automation.auto_welcome.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });

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
    sample = sample.replace(/{FEATURES}/g, '🗺️ 🤖 📢 👋 🏓 🔑 💬 ⏱️ 📍 🔍 🕐');
    sample = sample.replace(/{NODECOUNT}/g, '15');
    sample = sample.replace(/{DIRECTCOUNT}/g, '3');
    sample = sample.replace(/{TOTALNODES}/g, '156');

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
          {t('automation.auto_welcome.title')}
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
            title={t('automation.view_docs')}
          >
            ❓
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleMarkAllWelcomed}
            disabled={isMarkingWelcomed}
            className="btn-secondary"
            style={{
              padding: '0.5rem 1rem',
              fontSize: '14px',
              cursor: isMarkingWelcomed ? 'not-allowed' : 'pointer'
            }}
            title={t('automation.auto_welcome.mark_all_welcomed_tooltip')}
          >
            {isMarkingWelcomed ? t('automation.auto_welcome.marking') : t('automation.auto_welcome.mark_all_welcomed')}
          </button>
        </div>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5' }}>
          {t('automation.auto_welcome.description')}{' '}
          {t('automation.auto_welcome.tokens_info')}
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
              {t('automation.auto_welcome.wait_for_name')}
            </div>
            <span className="setting-description">
              {t('automation.auto_welcome.wait_for_name_description')}
            </span>
          </label>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="maxHops">
            {t('automation.auto_welcome.max_hops')}
            <span className="setting-description">
              {t('automation.auto_welcome.max_hops_description')}
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
            {t('automation.auto_welcome.broadcast_target')}
            <span className="setting-description">
              {t('automation.auto_welcome.broadcast_target_description')}
            </span>
          </label>
          <select
            id="welcomeTarget"
            value={localTarget}
            onChange={(e) => setLocalTarget(e.target.value)}
            disabled={!localEnabled}
            className="setting-input"
          >
            <option value="dm">{t('automation.auto_welcome.dm_to_new_node')}</option>
            {channels.map((channel, idx) => (
              <option key={channel.id} value={String(idx)}>
                {channel.name || `Channel ${idx}`}
              </option>
            ))}
          </select>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="welcomeMessage">
            {t('automation.auto_welcome.message_label')}
            <span className="setting-description">
              {t('automation.auto_welcome.message_description')} {t('automation.available_tokens')}: {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{TOTALNODES}'}
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
              '{DIRECTCOUNT}',
              '{TOTALNODES}'
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
            {t('automation.auto_welcome.sample_preview')}
            <span className="setting-description">
              {t('automation.auto_welcome.sample_preview_description')}
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
