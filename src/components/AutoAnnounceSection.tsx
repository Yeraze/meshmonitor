import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidCron } from 'cron-validator';

import { Channel } from '../types/device';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSaveBar } from '../hooks/useSaveBar';

interface AutoAnnounceSectionProps {
  enabled: boolean;
  intervalHours: number;
  message: string;
  channelIndex: number;
  announceOnStart: boolean;
  useSchedule: boolean;
  schedule: string;
  channels: Channel[];
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onIntervalChange: (hours: number) => void;
  onMessageChange: (message: string) => void;
  onChannelChange: (channelIndex: number) => void;
  onAnnounceOnStartChange: (announceOnStart: boolean) => void;
  onUseScheduleChange: (useSchedule: boolean) => void;
  onScheduleChange: (schedule: string) => void;
  // NodeInfo broadcasting props
  nodeInfoEnabled?: boolean;
  nodeInfoChannels?: number[];
  nodeInfoDelaySeconds?: number;
  onNodeInfoEnabledChange?: (enabled: boolean) => void;
  onNodeInfoChannelsChange?: (channels: number[]) => void;
  onNodeInfoDelayChange?: (seconds: number) => void;
}

const DEFAULT_MESSAGE = 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}';

const AutoAnnounceSection: React.FC<AutoAnnounceSectionProps> = ({
  enabled,
  intervalHours,
  message,
  channelIndex,
  announceOnStart,
  useSchedule,
  schedule,
  channels,
  baseUrl,
  onEnabledChange,
  onIntervalChange,
  onMessageChange,
  onChannelChange,
  onAnnounceOnStartChange,
  onUseScheduleChange,
  onScheduleChange,
  // NodeInfo broadcasting props
  nodeInfoEnabled = false,
  nodeInfoChannels = [],
  nodeInfoDelaySeconds = 30,
  onNodeInfoEnabledChange,
  onNodeInfoChannelsChange,
  onNodeInfoDelayChange,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localInterval, setLocalInterval] = useState(intervalHours || 6);
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localChannelIndex, setLocalChannelIndex] = useState(channelIndex || 0);
  const [localAnnounceOnStart, setLocalAnnounceOnStart] = useState(announceOnStart);
  const [localUseSchedule, setLocalUseSchedule] = useState(useSchedule);
  const [localSchedule, setLocalSchedule] = useState(schedule || '0 */6 * * *');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSendingNow, setIsSendingNow] = useState(false);
  const [lastAnnouncementTime, setLastAnnouncementTime] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // NodeInfo broadcasting local state
  const [localNodeInfoEnabled, setLocalNodeInfoEnabled] = useState(nodeInfoEnabled);
  const [localNodeInfoChannels, setLocalNodeInfoChannels] = useState<number[]>(nodeInfoChannels);
  const [localNodeInfoDelaySeconds, setLocalNodeInfoDelaySeconds] = useState(nodeInfoDelaySeconds);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalInterval(intervalHours || 6);
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalChannelIndex(channelIndex || 0);
    setLocalAnnounceOnStart(announceOnStart);
    setLocalUseSchedule(useSchedule);
    setLocalSchedule(schedule || '0 */6 * * *');
    setLocalNodeInfoEnabled(nodeInfoEnabled);
    setLocalNodeInfoChannels(nodeInfoChannels);
    setLocalNodeInfoDelaySeconds(nodeInfoDelaySeconds);
  }, [enabled, intervalHours, message, channelIndex, announceOnStart, useSchedule, schedule, nodeInfoEnabled, nodeInfoChannels, nodeInfoDelaySeconds]);

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

  // Validate cron expression whenever it changes
  useEffect(() => {
    if (localUseSchedule && localSchedule) {
      if (!isValidCron(localSchedule, { seconds: false, alias: true, allowBlankDay: true })) {
        setScheduleError(t('automation.auto_announce.invalid_cron'));
      } else {
        setScheduleError(null);
      }
    } else {
      setScheduleError(null);
    }
  }, [localSchedule, localUseSchedule, t]);

  // Helper to compare arrays
  const arraysEqual = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  };

  // Check if any settings have changed
  useEffect(() => {
    const changed =
      localEnabled !== enabled ||
      localInterval !== intervalHours ||
      localMessage !== message ||
      localChannelIndex !== channelIndex ||
      localAnnounceOnStart !== announceOnStart ||
      localUseSchedule !== useSchedule ||
      localSchedule !== schedule ||
      localNodeInfoEnabled !== nodeInfoEnabled ||
      !arraysEqual(localNodeInfoChannels, nodeInfoChannels) ||
      localNodeInfoDelaySeconds !== nodeInfoDelaySeconds;
    setHasChanges(changed);
  }, [localEnabled, localInterval, localMessage, localChannelIndex, localAnnounceOnStart, localUseSchedule, localSchedule, enabled, intervalHours, message, channelIndex, announceOnStart, useSchedule, schedule, localNodeInfoEnabled, localNodeInfoChannels, localNodeInfoDelaySeconds, nodeInfoEnabled, nodeInfoChannels, nodeInfoDelaySeconds]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalInterval(intervalHours || 6);
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalChannelIndex(channelIndex || 0);
    setLocalAnnounceOnStart(announceOnStart);
    setLocalUseSchedule(useSchedule);
    setLocalSchedule(schedule || '0 */6 * * *');
    setLocalNodeInfoEnabled(nodeInfoEnabled);
    setLocalNodeInfoChannels(nodeInfoChannels);
    setLocalNodeInfoDelaySeconds(nodeInfoDelaySeconds);
  }, [enabled, intervalHours, message, channelIndex, announceOnStart, useSchedule, schedule, nodeInfoEnabled, nodeInfoChannels, nodeInfoDelaySeconds]);

  // Wrap handleSave for useSaveBar (needs to be defined before useSaveBar call)
  const handleSaveForSaveBar = useCallback(async () => {
    // Validate cron expression before saving
    if (localUseSchedule && scheduleError) {
      showToast(t('automation.auto_announce.cannot_save_invalid_cron'), 'error');
      return;
    }

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
          autoAnnounceOnStart: String(localAnnounceOnStart),
          autoAnnounceUseSchedule: String(localUseSchedule),
          autoAnnounceSchedule: localSchedule,
          // NodeInfo broadcasting settings
          autoAnnounceNodeInfoEnabled: String(localNodeInfoEnabled),
          autoAnnounceNodeInfoChannels: JSON.stringify(localNodeInfoChannels),
          autoAnnounceNodeInfoDelaySeconds: localNodeInfoDelaySeconds
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
      onUseScheduleChange(localUseSchedule);
      onScheduleChange(localSchedule);
      onNodeInfoEnabledChange?.(localNodeInfoEnabled);
      onNodeInfoChannelsChange?.(localNodeInfoChannels);
      onNodeInfoDelayChange?.(localNodeInfoDelaySeconds);

      setHasChanges(false);
      showToast(t('automation.auto_announce.settings_saved_schedule'), 'success');
    } catch (error) {
      console.error('Failed to save auto-announce settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localUseSchedule, scheduleError, localEnabled, localInterval, localMessage, localChannelIndex, localAnnounceOnStart, localSchedule, localNodeInfoEnabled, localNodeInfoChannels, localNodeInfoDelaySeconds, baseUrl, csrfFetch, showToast, t, onEnabledChange, onIntervalChange, onMessageChange, onChannelChange, onAnnounceOnStartChange, onUseScheduleChange, onScheduleChange, onNodeInfoEnabledChange, onNodeInfoChannelsChange, onNodeInfoDelayChange]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-announce',
    sectionName: t('automation.auto_announce.title'),
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
    sample = sample.replace(/{VERSION}/g, '2.9.1');
    sample = sample.replace(/{DURATION}/g, '3d 12h');

    // Check which features would be shown
    const sampleFeatures: string[] = [];
    sampleFeatures.push('🗺️'); // Traceroute
    sampleFeatures.push('🤖'); // Auto-ack
    sampleFeatures.push('📢'); // Auto-announce
    sampleFeatures.push('👋'); // Auto-welcome
    sampleFeatures.push('🏓'); // Auto-ping
    sampleFeatures.push('🔑'); // Auto-key management
    sampleFeatures.push('💬'); // Auto-responder
    sampleFeatures.push('⏱️'); // Timed triggers
    sampleFeatures.push('📍'); // Geofence triggers
    sampleFeatures.push('🔍'); // Remote admin scan
    sampleFeatures.push('🕐'); // Auto time sync
    sample = sample.replace(/{FEATURES}/g, sampleFeatures.join(' '));

    sample = sample.replace(/{NODECOUNT}/g, '42');
    sample = sample.replace(/{DIRECTCOUNT}/g, '8');
    sample = sample.replace(/{TOTALNODES}/g, '156');

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
      showToast(result.message || t('automation.auto_announce.sent_success'), 'success');

      // Refresh last announcement time
      setLastAnnouncementTime(Date.now());
    } catch (error: any) {
      console.error('Failed to send announcement:', error);
      showToast(error.message || t('automation.auto_announce.send_failed'), 'error');
    } finally {
      setIsSendingNow(false);
    }
  };

  // Stable callbacks
  const handleSendNowClick = useCallback(() => {
    handleSendNow();
  }, [handleSendNow]);

  const createInsertTokenHandler = useCallback((token: string) => {
    return () => insertToken(token);
  }, [insertToken]);

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
          {t('automation.auto_announce.title')}
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
            title={t('automation.view_docs')}
          >
            ❓
          </a>
        </h2>
        <div className="automation-button-container" style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={handleSendNowClick}
            disabled={isSendingNow || !localEnabled}
            className="btn-primary"
            style={{
              padding: '0.5rem 1.5rem',
              fontSize: '14px',
              opacity: (localEnabled && !isSendingNow) ? 1 : 0.5,
              cursor: (localEnabled && !isSendingNow) ? 'pointer' : 'not-allowed'
            }}
          >
            {isSendingNow ? t('automation.auto_announce.sending') : t('automation.auto_announce.send_now')}
          </button>
        </div>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5' }}>
          {t('automation.auto_announce.description')}
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
            <strong>{t('automation.auto_announce.last_announcement')}:</strong> {new Date(lastAnnouncementTime).toLocaleString()}
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
              {t('automation.auto_announce.announce_on_start')}
            </div>
            <span className="setting-description">
              {t('automation.auto_announce.announce_on_start_description')}
            </span>
          </label>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="useSchedule">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                id="useSchedule"
                type="checkbox"
                checked={localUseSchedule}
                onChange={(e) => setLocalUseSchedule(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              {t('automation.auto_announce.scheduled_sends')}
            </div>
            <span className="setting-description">
              {t('automation.auto_announce.scheduled_sends_description')}
            </span>
          </label>
        </div>

        {localUseSchedule && (
          <div className="setting-item" style={{ marginTop: '1rem', marginLeft: '1.5rem' }}>
            <label htmlFor="scheduleExpression">
              {t('automation.auto_announce.cron_expression')}
              <span className="setting-description">
                {t('automation.auto_announce.cron_expression_description')}{' '}
                <a
                  href="https://crontab.guru/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#89b4fa', textDecoration: 'underline' }}
                >
                  {t('automation.auto_announce.cron_help_link')}
                </a>
              </span>
            </label>
            <input
              id="scheduleExpression"
              type="text"
              value={localSchedule}
              onChange={(e) => setLocalSchedule(e.target.value)}
              disabled={!localEnabled}
              className="setting-input"
              placeholder="0 */6 * * *"
              style={{
                fontFamily: 'monospace',
                borderColor: scheduleError ? 'var(--ctp-red)' : undefined
              }}
            />
            {scheduleError && (
              <div style={{
                color: 'var(--ctp-red)',
                fontSize: '0.875rem',
                marginTop: '0.25rem'
              }}>
                {scheduleError}
              </div>
            )}
            {!scheduleError && localSchedule && (
              <div style={{
                color: 'var(--ctp-green)',
                fontSize: '0.875rem',
                marginTop: '0.25rem'
              }}>
                {t('automation.auto_announce.valid_cron')}
              </div>
            )}
          </div>
        )}

        {!localUseSchedule && (
          <div className="setting-item" style={{ marginTop: '1rem' }}>
            <label htmlFor="announceInterval">
                {t('automation.auto_announce.interval')}
              <span className="setting-description">
                {t('automation.auto_announce.interval_description')}
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
        )}

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="announceChannel">
            {t('automation.auto_announce.broadcast_channel')}
            <span className="setting-description">
              {t('automation.auto_announce.broadcast_channel_description')}
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
            {t('automation.auto_announce.message_label')}
            <span className="setting-description">
              {t('automation.auto_announce.message_description')}
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
              onClick={createInsertTokenHandler('{VERSION}')}
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
              onClick={createInsertTokenHandler('{DURATION}')}
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
              onClick={createInsertTokenHandler('{FEATURES}')}
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
              onClick={createInsertTokenHandler('{NODECOUNT}')}
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
              onClick={createInsertTokenHandler('{DIRECTCOUNT}')}
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
              onClick={createInsertTokenHandler('{TOTALNODES}')}
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
              + {'{TOTALNODES}'}
            </button>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.auto_announce.sample_preview')}
            <span className="setting-description">
              {t('automation.auto_announce.sample_preview_description')}
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
          <strong>{t('automation.auto_announce.feature_emojis')}:</strong>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.5rem' }}>
            <li>{t('automation.auto_announce.feature_traceroute')}</li>
            <li>{t('automation.auto_announce.feature_acknowledge')}</li>
            <li>{t('automation.auto_announce.feature_announce')}</li>
            <li>{t('automation.auto_announce.feature_welcome')}</li>
          </ul>
        </div>

        {/* NodeInfo Broadcasting Section */}
        <div style={{
          marginTop: '2rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '8px'
        }}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={localNodeInfoEnabled}
                onChange={(e) => setLocalNodeInfoEnabled(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              {t('automation.auto_announce.nodeinfo_title')}
            </label>
            <p style={{ marginTop: '0.5rem', color: 'var(--ctp-subtext0)', fontSize: '0.9rem' }}>
              {t('automation.auto_announce.nodeinfo_description')}
            </p>
          </div>

          {localNodeInfoEnabled && (
            <>
              <div className="setting-item" style={{ marginTop: '1rem' }}>
                <label>
                  {t('automation.auto_announce.nodeinfo_channels')}
                  <span className="setting-description">
                    {t('automation.auto_announce.nodeinfo_channels_description')}
                  </span>
                </label>
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.75rem',
                  background: 'var(--ctp-surface1)',
                  borderRadius: '4px'
                }}>
                  {channels.map((channel, idx) => (
                    <div
                      key={channel.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: '0.5rem',
                        marginBottom: idx < channels.length - 1 ? '0.5rem' : 0
                      }}
                    >
                      <input
                        type="checkbox"
                        id={`nodeinfo-channel-${idx}`}
                        checked={localNodeInfoChannels.includes(idx)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setLocalNodeInfoChannels([...localNodeInfoChannels, idx]);
                          } else {
                            setLocalNodeInfoChannels(localNodeInfoChannels.filter(ch => ch !== idx));
                          }
                        }}
                        disabled={!localEnabled}
                        style={{
                          width: 'auto',
                          minWidth: '16px',
                          margin: 0,
                          cursor: localEnabled ? 'pointer' : 'not-allowed',
                          flexShrink: 0
                        }}
                      />
                      <label
                        htmlFor={`nodeinfo-channel-${idx}`}
                        style={{
                          color: idx === 0 ? 'var(--ctp-yellow)' : 'inherit',
                          cursor: localEnabled ? 'pointer' : 'not-allowed',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {channel.name || `Channel ${idx}`}
                        {idx === 0 && ' (Primary)'}
                      </label>
                    </div>
                  ))}
                </div>
                {localNodeInfoChannels.length === 0 && localNodeInfoEnabled && (
                  <div style={{
                    marginTop: '0.5rem',
                    color: 'var(--ctp-yellow)',
                    fontSize: '0.875rem'
                  }}>
                    {t('automation.auto_announce.nodeinfo_no_channels_warning')}
                  </div>
                )}
              </div>

              <div className="setting-item" style={{ marginTop: '1rem' }}>
                <label htmlFor="nodeInfoDelay">
                  {t('automation.auto_announce.nodeinfo_delay')}
                  <span className="setting-description">
                    {t('automation.auto_announce.nodeinfo_delay_description')}
                  </span>
                </label>
                <input
                  id="nodeInfoDelay"
                  type="number"
                  min="10"
                  max="300"
                  value={localNodeInfoDelaySeconds}
                  onChange={(e) => setLocalNodeInfoDelaySeconds(parseInt(e.target.value) || 30)}
                  disabled={!localEnabled}
                  className="setting-input"
                  style={{ width: '100px' }}
                />
                <span style={{ marginLeft: '0.5rem', color: 'var(--ctp-subtext0)' }}>
                  {t('automation.auto_announce.seconds')}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default AutoAnnounceSection;
