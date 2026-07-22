import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSourceQuery } from '../hooks/useSourceQuery';
import { useSettings } from '../contexts/SettingsContext';
import { formatTime, formatDate } from '../utils/datetime';
import { Channel } from '../types/device';
import { useSaveBar } from '../hooks/useSaveBar';
import {
  AutoAckMatrix,
  AutoAckCellId,
  AUTOACK_CELLS,
  matrixToSettings,
} from '../utils/autoAckMatrix';
import { hasRE2IncompatibleConstructs } from '../utils/autoAckRegex';
import { UiIcon } from './icons';

interface AutoAcknowledgeSectionProps {
  enabled: boolean;
  regex: string;
  message: string;
  messageDirect: string;
  channels: Channel[];
  enabledChannels: number[];
  skipIncompleteNodes: boolean;
  ignoredNodes: string;
  matrix: AutoAckMatrix;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onRegexChange: (regex: string) => void;
  onMessageChange: (message: string) => void;
  onMessageDirectChange: (message: string) => void;
  onChannelsChange: (channels: number[]) => void;
  onSkipIncompleteNodesChange: (enabled: boolean) => void;
  onIgnoredNodesChange: (ignoredNodes: string) => void;
  onMatrixChange: (m: AutoAckMatrix) => void;
  cooldownSeconds: number;
  onCooldownSecondsChange: (value: number) => void;
  preSendDelaySeconds: number;
  onPreSendDelaySecondsChange: (value: number) => void;
  maxAttempts: number;
  onMaxAttemptsChange: (value: number) => void;
  testMessages: string;
  onTestMessagesChange: (messages: string) => void;
}

const DEFAULT_MESSAGE = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
const DEFAULT_MESSAGE_DIRECT = '🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}';

const AutoAcknowledgeSection: React.FC<AutoAcknowledgeSectionProps> = ({
  enabled,
  regex,
  message,
  messageDirect,
  channels,
  enabledChannels,
  skipIncompleteNodes,
  ignoredNodes,
  matrix,
  baseUrl,
  onEnabledChange,
  onRegexChange,
  onMessageChange,
  onMessageDirectChange,
  onChannelsChange,
  onSkipIncompleteNodesChange,
  onIgnoredNodesChange,
  onMatrixChange,
  cooldownSeconds,
  onCooldownSecondsChange,
  preSendDelaySeconds,
  onPreSendDelaySecondsChange,
  maxAttempts,
  onMaxAttemptsChange,
  testMessages: testMessagesProp,
  onTestMessagesChange,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const csrfFetch = useCsrfFetch();
  const sourceQuery = useSourceQuery();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localRegex, setLocalRegex] = useState(regex || '^(test|ping)');
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localMessageDirect, setLocalMessageDirect] = useState(messageDirect || DEFAULT_MESSAGE_DIRECT);
  const [localEnabledChannels, setLocalEnabledChannels] = useState<number[]>(enabledChannels);
  const [localSkipIncompleteNodes, setLocalSkipIncompleteNodes] = useState(skipIncompleteNodes);
  const [localIgnoredNodes, setLocalIgnoredNodes] = useState(ignoredNodes || '');
  const [localMatrix, setLocalMatrix] = useState<AutoAckMatrix>(matrix);
  const [localCooldownSeconds, setLocalCooldownSeconds] = useState(cooldownSeconds);
  const [localPreSendDelaySeconds, setLocalPreSendDelaySeconds] = useState(preSendDelaySeconds);
  const [localMaxAttempts, setLocalMaxAttempts] = useState(maxAttempts);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testMessages, setTestMessages] = useState(testMessagesProp || 'test\nTest message\nping\nPING\nHello world\nTESTING 123');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaDirectRef = useRef<HTMLTextAreaElement>(null);

  // Update local state when props change
  useEffect(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || '^(test|ping)');
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalMessageDirect(messageDirect || DEFAULT_MESSAGE_DIRECT);
    setLocalEnabledChannels(enabledChannels);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
    setLocalIgnoredNodes(ignoredNodes || '');
    setLocalMatrix(matrix);
    setLocalCooldownSeconds(cooldownSeconds);
    setLocalPreSendDelaySeconds(preSendDelaySeconds);
    setLocalMaxAttempts(maxAttempts);
    if (testMessagesProp) {
      setTestMessages(testMessagesProp);
    }
  }, [enabled, regex, message, messageDirect, enabledChannels, skipIncompleteNodes, ignoredNodes, matrix, cooldownSeconds, preSendDelaySeconds, maxAttempts, testMessagesProp]);

  // Check if any settings have changed
  useEffect(() => {
    const channelsChanged = JSON.stringify(localEnabledChannels.sort()) !== JSON.stringify(enabledChannels.sort());
    const cooldownChanged = localCooldownSeconds !== cooldownSeconds;
    const preSendDelayChanged = localPreSendDelaySeconds !== preSendDelaySeconds;
    const maxAttemptsChanged = localMaxAttempts !== maxAttempts;
    const matrixChanged = JSON.stringify(localMatrix) !== JSON.stringify(matrix);
    const changed = localEnabled !== enabled || localRegex !== regex || localMessage !== message || localMessageDirect !== messageDirect || channelsChanged || localSkipIncompleteNodes !== skipIncompleteNodes || localIgnoredNodes !== (ignoredNodes || '') || matrixChanged || cooldownChanged || preSendDelayChanged || maxAttemptsChanged || testMessages !== (testMessagesProp || 'test\nTest message\nping\nPING\nHello world\nTESTING 123');
    setHasChanges(changed);
  }, [localEnabled, localRegex, localMessage, localMessageDirect, localEnabledChannels, localSkipIncompleteNodes, localIgnoredNodes, localMatrix, localCooldownSeconds, localPreSendDelaySeconds, localMaxAttempts, testMessages, enabled, regex, message, messageDirect, enabledChannels, skipIncompleteNodes, ignoredNodes, matrix, cooldownSeconds, preSendDelaySeconds, maxAttempts, testMessagesProp]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || '^(test|ping)');
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalMessageDirect(messageDirect || DEFAULT_MESSAGE_DIRECT);
    setLocalEnabledChannels(enabledChannels);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
    setLocalIgnoredNodes(ignoredNodes || '');
    setLocalMatrix(matrix);
    setLocalCooldownSeconds(cooldownSeconds);
    setLocalPreSendDelaySeconds(preSendDelaySeconds);
    setLocalMaxAttempts(maxAttempts);
    setTestMessages(testMessagesProp || 'test\nTest message\nping\nPING\nHello world\nTESTING 123');
  }, [enabled, regex, message, messageDirect, enabledChannels, skipIncompleteNodes, ignoredNodes, matrix, cooldownSeconds, preSendDelaySeconds, maxAttempts, testMessagesProp]);

  // Validate regex pattern for safety
  const validateRegex = (pattern: string): { valid: boolean; error?: string } => {
    // Check length
    if (pattern.length > 100) {
      return { valid: false, error: t('automation.auto_ack.pattern_too_long') };
    }

    // Check for potentially dangerous patterns
    if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
      return { valid: false, error: t('automation.auto_ack.pattern_too_complex') };
    }

    // Reject lookaround/backreferences the server's RE2 engine can't compile
    // (#3806). The browser's native RegExp below would happily accept them,
    // letting a pattern be persisted that every subsequent save then 400s on.
    if (hasRE2IncompatibleConstructs(pattern)) {
      return { valid: false, error: t('automation.auto_ack.unsupported_regex') };
    }

    // Try to compile
    try {
      new RegExp(pattern, 'i');
      return { valid: true };
    } catch (_error) {
      return { valid: false, error: t('automation.auto_ack.invalid_regex') };
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
    } catch (_error) {
      // Invalid regex
      return false;
    }
  };

  // Generate sample message with example token values
  const generateSampleMessage = (isDirect: boolean = false): string => {
    let sample = isDirect ? localMessageDirect : localMessage;

    // Replace with sample values
    const now = new Date();
    sample = sample.replace(/{NODE_ID}/g, '!a1b2c3d4');
    sample = sample.replace(/{NUMBER_HOPS}/g, isDirect ? '0' : '3');
    sample = sample.replace(/{HOPS}/g, isDirect ? '0' : '3');
    sample = sample.replace(/{RABBIT_HOPS}/g, isDirect ? '🎯' : '🐇🐇🐇'); // 🎯 for direct, 3 rabbits for 3 hops
    sample = sample.replace(/{DATE}/g, formatDate(now, dateFormat));
    sample = sample.replace(/{TIME}/g, formatTime(now, timeFormat));
    sample = sample.replace(/{VERSION}/g, '2.9.1');
    sample = sample.replace(/{DURATION}/g, '3d 12h');
    sample = sample.replace(/{LONG_NAME}/g, 'Meshtastic ABC1');
    sample = sample.replace(/{SHORT_NAME}/g, 'ABC1');

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
    sample = sample.replace(/{SNR}/g, '7.5');
    sample = sample.replace(/{RSSI}/g, '-95');
    sample = sample.replace(/{TRANSPORT}/g, 'LoRa'); // Sample transport type
    sample = sample.replace(/{LAST_HOP}/g, isDirect ? 'unknown' : 'RLY1'); // Relay short name (no relay on direct)

    return sample;
  };

  // Immutably update a single field of a single matrix cell.
  // Toggling reply off also forces replyDm off (reply-DM applies to the reply only).
  const updateCell = (id: AutoAckCellId, field: keyof AutoAckMatrix[AutoAckCellId], value: boolean) => {
    setLocalMatrix(prev => {
      const nextCell = { ...prev[id], [field]: value };
      if (field === 'reply' && !value) {
        nextCell.replyDm = false;
      }
      return { ...prev, [id]: nextCell };
    });
  };

  const handleSaveForSaveBar = useCallback(async () => {
    // Validate regex before saving
    const validation = validateRegex(localRegex);
    if (!validation.valid) {
      showToast(`Invalid regex pattern: ${validation.error}`, 'error');
      return;
    }

    setIsSaving(true);
    try {
      // Sync to backend first
      const response = await csrfFetch(`${baseUrl}/api/settings${sourceQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAckEnabled: String(localEnabled),
          autoAckRegex: localRegex,
          autoAckMessage: localMessage,
          autoAckMessageDirect: localMessageDirect,
          autoAckChannels: localEnabledChannels.join(','),
          autoAckSkipIncompleteNodes: String(localSkipIncompleteNodes),
          autoAckIgnoredNodes: localIgnoredNodes,
          ...matrixToSettings(localMatrix),
          autoAckCooldownSeconds: String(localCooldownSeconds),
          autoAckPreSendDelaySeconds: String(localPreSendDelaySeconds),
          autoAckMaxAttempts: String(localMaxAttempts),
          autoAckTestMessages: testMessages
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        // Surface the server's specific error (e.g. an invalid regex) instead of
        // the generic failure toast, so a stuck user understands what to fix
        // rather than seeing an opaque "save failed" message (#3806).
        let serverError = '';
        try {
          const body = await response.json();
          if (body && typeof body.error === 'string') serverError = body.error;
        } catch {
          // Response had no JSON body — fall back to the generic message below.
        }
        showToast(serverError || t('automation.settings_save_failed'), 'error');
        return;
      }

      // Only update parent state after successful API call (no localStorage)
      onEnabledChange(localEnabled);
      onRegexChange(localRegex);
      onMessageChange(localMessage);
      onMessageDirectChange(localMessageDirect);
      onChannelsChange(localEnabledChannels);
      onSkipIncompleteNodesChange(localSkipIncompleteNodes);
      onIgnoredNodesChange(localIgnoredNodes);
      onMatrixChange(localMatrix);
      onCooldownSecondsChange(localCooldownSeconds);
      onPreSendDelaySecondsChange(localPreSendDelaySeconds);
      onMaxAttemptsChange(localMaxAttempts);
      onTestMessagesChange(testMessages);

      setHasChanges(false);
      showToast(t('automation.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-acknowledge settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localRegex, localEnabled, localMessage, localMessageDirect, localEnabledChannels, localSkipIncompleteNodes, localIgnoredNodes, localMatrix, localCooldownSeconds, localPreSendDelaySeconds, localMaxAttempts, testMessages, baseUrl, csrfFetch, sourceQuery, showToast, t, onEnabledChange, onRegexChange, onMessageChange, onMessageDirectChange, onChannelsChange, onSkipIncompleteNodesChange, onIgnoredNodesChange, onMatrixChange, onCooldownSecondsChange, onPreSendDelaySecondsChange, onMaxAttemptsChange, onTestMessagesChange]);

  // Register with SaveBar
  useSaveBar({
    id: 'auto-acknowledge',
    sectionName: t('automation.auto_ack.title'),
    hasChanges,
    isSaving,
    onSave: handleSaveForSaveBar,
    onDismiss: resetChanges
  });
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
          {t('automation.auto_ack.title')}
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
            title={t('automation.view_docs')}
          >
            <UiIcon name="help" />
          </a>
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: localEnabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: '1.5', marginLeft: '1.75rem' }}>
          {t('automation.auto_ack.description')}
          {' '}{t('automation.auto_ack.tokens_info')}
        </p>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="autoAckRegex">
            {t('automation.auto_ack.regex_label')}
            <span className="setting-description">
              {t('automation.auto_ack.regex_description')}
              {' '}{t('automation.auto_ack.regex_default')}
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
            {t('automation.auto_ack.active_channels')}
            <span className="setting-description">
              {t('automation.auto_ack.active_channels_description')}
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            {channels.map((channel, idx) => (
              <div key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id={`autoAckChannel${idx}`}
                  checked={localEnabledChannels.includes(channel.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setLocalEnabledChannels([...localEnabledChannels, channel.id]);
                    } else {
                      setLocalEnabledChannels(localEnabledChannels.filter(c => c !== channel.id));
                    }
                  }}
                  disabled={!localEnabled}
                  style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
                />
                <label htmlFor={`autoAckChannel${idx}`} style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}>
                  {channel.name || `Channel ${channel.id}`}
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('automation.auto_ack.security')}
            <span className="setting-description">
              {t('automation.auto_ack.security_description')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="autoAckSkipIncomplete"
              checked={localSkipIncompleteNodes}
              onChange={(e) => setLocalSkipIncompleteNodes(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoAckSkipIncomplete" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
              {t('automation.auto_ack.skip_incomplete')}
            </label>
          </div>
          <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t('automation.auto_ack.skip_incomplete_description')}
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label htmlFor="autoAckIgnoredNodes" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('automation.auto_ack.node_ignore_list')}
            </label>
            <div style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.node_ignore_list_description')}
            </div>
            <textarea
              id="autoAckIgnoredNodes"
              value={localIgnoredNodes}
              onChange={(e) => setLocalIgnoredNodes(e.target.value)}
              placeholder={`!a1b2c3d4\n!d5c4b3a2`}
              disabled={!localEnabled}
              className="setting-input"
              rows={3}
              style={{
                fontFamily: 'monospace',
                resize: 'vertical',
                minHeight: '70px'
              }}
            />
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('automation.auto_ack.cooldown_label')}
            </label>
            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.cooldown_description')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="number"
                value={localCooldownSeconds}
                onChange={(e) => setLocalCooldownSeconds(Math.max(0, parseInt(e.target.value) || 0))}
                min={0}
                disabled={!localEnabled}
                style={{ width: '80px', padding: '2px 4px' }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('automation.auto_ack.cooldown_help')}
              </span>
            </div>
          </div>

          {/* Pre-send delay (#3876) — wait before replying so a repeater can finish its TX. */}
          <div style={{ marginTop: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('automation.auto_ack.presend_delay_label', 'Pre-Send Delay')}
            </label>
            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.presend_delay_description', 'Wait this many seconds before sending the acknowledgement. Gives a repeater time to finish its own transmission so a zero-hop ack is not dropped. 0 sends immediately.')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="number"
                value={localPreSendDelaySeconds}
                onChange={(e) => setLocalPreSendDelaySeconds(Math.max(0, Math.min(120, parseInt(e.target.value) || 0)))}
                min={0}
                max={120}
                disabled={!localEnabled}
                style={{ width: '80px', padding: '2px 4px' }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('automation.auto_ack.presend_delay_help', 'seconds (0 = send immediately, max 120)')}
              </span>
            </div>
          </div>

          {/* DM resend attempts (#4266) — app-level retry cap, bounded to [1,3] server-side. */}
          <div style={{ marginTop: '1rem' }}>
            <label htmlFor="autoAckMaxAttempts" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
              {t('automation.auto_ack.max_attempts_label', 'Auto-Ack Resend Attempts')}
            </label>
            <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.max_attempts_description', 'How many times to resend an unacknowledged DM auto-ack reply. Lower values save airtime on busy channels; higher values improve delivery reliability. Channel replies always send once.')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <select
                id="autoAckMaxAttempts"
                value={localMaxAttempts}
                onChange={(e) => setLocalMaxAttempts(Math.max(1, Math.min(3, parseInt(e.target.value) || 3)))}
                disabled={!localEnabled}
                style={{ width: '80px', padding: '2px 4px' }}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
              <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('automation.auto_ack.max_attempts_help', 'attempts (1 = least airtime, 3 = default)')}
              </span>
            </div>
          </div>
        </div>

        {/* Response matrix: {Channel | Direct} × {0 hops | Multi-hop} */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('automation.auto_ack.response_matrix')}
            <span className="setting-description">
              {t('automation.auto_ack.response_matrix_description')}
            </span>
          </label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '1rem',
              marginTop: '0.75rem',
              opacity: localEnabled ? 1 : 0.5,
            }}
          >
            {AUTOACK_CELLS.map((cell) => {
              const config = localMatrix[cell.id];
              const isDirect = cell.type === 'direct';
              const borderColor = cell.hop === 'zeroHop' ? 'var(--ctp-green)' : 'var(--ctp-blue)';
              // Direct replies are inherently DMs: show the "Respond via DM" checkbox
              // checked + disabled. Channel cells gate it on the cell's reply toggle.
              const replyDmChecked = isDirect ? true : config.replyDm;
              const replyDmDisabled = !localEnabled || isDirect || !config.reply;
              const replyDmTitle = isDirect
                ? t('automation.auto_ack.direct_reply_always_dm')
                : undefined;
              return (
                <div
                  key={cell.id}
                  style={{
                    padding: '1rem',
                    background: 'var(--ctp-surface0)',
                    border: `2px solid ${borderColor}`,
                    borderRadius: '8px',
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: '0.75rem' }}>{cell.label}</div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <input
                      type="checkbox"
                      id={`autoAck-${cell.id}-reply`}
                      checked={config.reply}
                      onChange={(e) => updateCell(cell.id, 'reply', e.target.checked)}
                      disabled={!localEnabled}
                      style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
                    />
                    <label htmlFor={`autoAck-${cell.id}-reply`} style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}>
                      {t('automation.auto_ack.matrix_message')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <input
                      type="checkbox"
                      id={`autoAck-${cell.id}-tapback`}
                      checked={config.tapback}
                      onChange={(e) => updateCell(cell.id, 'tapback', e.target.checked)}
                      disabled={!localEnabled}
                      style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
                    />
                    <label htmlFor={`autoAck-${cell.id}-tapback`} style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}>
                      {t('automation.auto_ack.matrix_tapback')}
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      id={`autoAck-${cell.id}-replyDm`}
                      checked={replyDmChecked}
                      onChange={(e) => updateCell(cell.id, 'replyDm', e.target.checked)}
                      disabled={replyDmDisabled}
                      title={replyDmTitle}
                      style={{ width: 'auto', margin: 0, cursor: replyDmDisabled ? 'not-allowed' : 'pointer' }}
                    />
                    <label
                      htmlFor={`autoAck-${cell.id}-replyDm`}
                      title={replyDmTitle}
                      style={{ margin: 0, cursor: replyDmDisabled ? 'not-allowed' : 'pointer' }}
                    >
                      {t('automation.auto_ack.matrix_respond_via_dm')}
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Multi-hop reply template */}
        <div className="setting-item" style={{ marginTop: '1.5rem', opacity: localEnabled ? 1 : 0.5 }}>
          <label htmlFor="autoAckMessage" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {t('automation.auto_ack.message_multihop')}
            <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
              {t('automation.auto_ack.tokens_hint', 'Supports message tokens — see the reference at the top of this page.')}
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
          <div style={{ marginTop: '0.5rem' }}>
            <label style={{ fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.sample_preview_multihop')}:
            </label>
            <div style={{
              marginTop: '0.25rem',
              padding: '0.5rem',
              background: 'var(--ctp-base)',
              border: '1px solid var(--ctp-blue)',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.9rem',
              color: 'var(--ctp-text)'
            }}>
              {generateSampleMessage(false)}
            </div>
          </div>
        </div>

        {/* Direct (0-hop) reply template */}
        <div className="setting-item" style={{ marginTop: '1.5rem', opacity: localEnabled ? 1 : 0.5 }}>
          <label htmlFor="autoAckMessageDirect" style={{ display: 'block', marginBottom: '0.5rem' }}>
            {t('automation.auto_ack.message_direct')}
            <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
              {t('automation.auto_ack.tokens_hint', 'Supports message tokens — see the reference at the top of this page.')}
            </span>
          </label>
          <textarea
            id="autoAckMessageDirect"
            ref={textareaDirectRef}
            value={localMessageDirect}
            onChange={(e) => setLocalMessageDirect(e.target.value)}
            disabled={!localEnabled}
            className="setting-input"
            rows={3}
            style={{
              fontFamily: 'monospace',
              resize: 'vertical',
              minHeight: '60px'
            }}
          />
          <div style={{ marginTop: '0.5rem' }}>
            <label style={{ fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.sample_preview_direct')}:
            </label>
            <div style={{
              marginTop: '0.25rem',
              padding: '0.5rem',
              background: 'var(--ctp-base)',
              border: '1px solid var(--ctp-green)',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.9rem',
              color: 'var(--ctp-text)'
            }}>
              {generateSampleMessage(true)}
            </div>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="testMessages">
            {t('automation.auto_ack.pattern_testing')}
            <span className="setting-description">
              {t('automation.auto_ack.pattern_testing_description')}
            </span>
          </label>
          <div className="auto-ack-test-container">
            <div>
              <textarea
                id="testMessages"
                value={testMessages}
                onChange={(e) => setTestMessages(e.target.value)}
                placeholder={t('automation.auto_ack.test_placeholder')}
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
