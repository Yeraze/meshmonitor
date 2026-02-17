import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { useSettings } from '../contexts/SettingsContext';
import { formatTime, formatDate } from '../utils/datetime';
import { Channel } from '../types/device';
import { useSaveBar } from '../hooks/useSaveBar';

interface AutoAcknowledgeSectionProps {
  enabled: boolean;
  regex: string;
  message: string;
  messageDirect: string;
  channels: Channel[];
  enabledChannels: number[];
  directMessagesEnabled: boolean;
  useDM: boolean;
  skipIncompleteNodes: boolean;
  tapbackEnabled: boolean;
  replyEnabled: boolean;
  // New direct/multihop settings
  directEnabled: boolean;
  directTapbackEnabled: boolean;
  directReplyEnabled: boolean;
  multihopEnabled: boolean;
  multihopTapbackEnabled: boolean;
  multihopReplyEnabled: boolean;
  baseUrl: string;
  onEnabledChange: (enabled: boolean) => void;
  onRegexChange: (regex: string) => void;
  onMessageChange: (message: string) => void;
  onMessageDirectChange: (message: string) => void;
  onChannelsChange: (channels: number[]) => void;
  onDirectMessagesChange: (enabled: boolean) => void;
  onUseDMChange: (enabled: boolean) => void;
  onSkipIncompleteNodesChange: (enabled: boolean) => void;
  onTapbackEnabledChange: (enabled: boolean) => void;
  onReplyEnabledChange: (enabled: boolean) => void;
  // New direct/multihop callbacks
  onDirectEnabledChange: (enabled: boolean) => void;
  onDirectTapbackEnabledChange: (enabled: boolean) => void;
  onDirectReplyEnabledChange: (enabled: boolean) => void;
  onMultihopEnabledChange: (enabled: boolean) => void;
  onMultihopTapbackEnabledChange: (enabled: boolean) => void;
  onMultihopReplyEnabledChange: (enabled: boolean) => void;
  testMessages: string;
  onTestMessagesChange: (messages: string) => void;
}

const DEFAULT_MESSAGE = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
const DEFAULT_MESSAGE_DIRECT = '🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}';

// Hop count emojis for tapback (keycap digits 0-7+)
const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

const AutoAcknowledgeSection: React.FC<AutoAcknowledgeSectionProps> = ({
  enabled,
  regex,
  message,
  messageDirect,
  channels,
  enabledChannels,
  directMessagesEnabled,
  useDM,
  skipIncompleteNodes,
  tapbackEnabled,
  replyEnabled,
  directEnabled,
  directTapbackEnabled,
  directReplyEnabled,
  multihopEnabled,
  multihopTapbackEnabled,
  multihopReplyEnabled,
  baseUrl,
  onEnabledChange,
  onRegexChange,
  onMessageChange,
  onMessageDirectChange,
  onChannelsChange,
  onDirectMessagesChange,
  onUseDMChange,
  onSkipIncompleteNodesChange,
  onTapbackEnabledChange,
  onReplyEnabledChange,
  onDirectEnabledChange,
  onDirectTapbackEnabledChange,
  onDirectReplyEnabledChange,
  onMultihopEnabledChange,
  onMultihopTapbackEnabledChange,
  onMultihopReplyEnabledChange,
  testMessages: testMessagesProp,
  onTestMessagesChange,
}) => {
  const { t } = useTranslation();
  const { timeFormat, dateFormat } = useSettings();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localRegex, setLocalRegex] = useState(regex || '^(test|ping)');
  const [localMessage, setLocalMessage] = useState(message || DEFAULT_MESSAGE);
  const [localMessageDirect, setLocalMessageDirect] = useState(messageDirect || DEFAULT_MESSAGE_DIRECT);
  const [localEnabledChannels, setLocalEnabledChannels] = useState<number[]>(enabledChannels);
  const [localDirectMessagesEnabled, setLocalDirectMessagesEnabled] = useState(directMessagesEnabled);
  const [localUseDM, setLocalUseDM] = useState(useDM);
  const [localSkipIncompleteNodes, setLocalSkipIncompleteNodes] = useState(skipIncompleteNodes);
  const [localTapbackEnabled, setLocalTapbackEnabled] = useState(tapbackEnabled);
  const [localReplyEnabled, setLocalReplyEnabled] = useState(replyEnabled);
  const [localDirectEnabled, setLocalDirectEnabled] = useState(directEnabled);
  const [localDirectTapbackEnabled, setLocalDirectTapbackEnabled] = useState(directTapbackEnabled);
  const [localDirectReplyEnabled, setLocalDirectReplyEnabled] = useState(directReplyEnabled);
  const [localMultihopEnabled, setLocalMultihopEnabled] = useState(multihopEnabled);
  const [localMultihopTapbackEnabled, setLocalMultihopTapbackEnabled] = useState(multihopTapbackEnabled);
  const [localMultihopReplyEnabled, setLocalMultihopReplyEnabled] = useState(multihopReplyEnabled);
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
    setLocalDirectMessagesEnabled(directMessagesEnabled);
    setLocalUseDM(useDM);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
    setLocalTapbackEnabled(tapbackEnabled);
    setLocalReplyEnabled(replyEnabled);
    setLocalDirectEnabled(directEnabled);
    setLocalDirectTapbackEnabled(directTapbackEnabled);
    setLocalDirectReplyEnabled(directReplyEnabled);
    setLocalMultihopEnabled(multihopEnabled);
    setLocalMultihopTapbackEnabled(multihopTapbackEnabled);
    setLocalMultihopReplyEnabled(multihopReplyEnabled);
    if (testMessagesProp) {
      setTestMessages(testMessagesProp);
    }
  }, [enabled, regex, message, messageDirect, enabledChannels, directMessagesEnabled, useDM, skipIncompleteNodes, tapbackEnabled, replyEnabled, directEnabled, directTapbackEnabled, directReplyEnabled, multihopEnabled, multihopTapbackEnabled, multihopReplyEnabled, testMessagesProp]);

  // Check if any settings have changed
  useEffect(() => {
    const channelsChanged = JSON.stringify(localEnabledChannels.sort()) !== JSON.stringify(enabledChannels.sort());
    const changed = localEnabled !== enabled || localRegex !== regex || localMessage !== message || localMessageDirect !== messageDirect || channelsChanged || localDirectMessagesEnabled !== directMessagesEnabled || localUseDM !== useDM || localSkipIncompleteNodes !== skipIncompleteNodes || localTapbackEnabled !== tapbackEnabled || localReplyEnabled !== replyEnabled || localDirectEnabled !== directEnabled || localDirectTapbackEnabled !== directTapbackEnabled || localDirectReplyEnabled !== directReplyEnabled || localMultihopEnabled !== multihopEnabled || localMultihopTapbackEnabled !== multihopTapbackEnabled || localMultihopReplyEnabled !== multihopReplyEnabled || testMessages !== (testMessagesProp || 'test\nTest message\nping\nPING\nHello world\nTESTING 123');
    setHasChanges(changed);
  }, [localEnabled, localRegex, localMessage, localMessageDirect, localEnabledChannels, localDirectMessagesEnabled, localUseDM, localSkipIncompleteNodes, localTapbackEnabled, localReplyEnabled, localDirectEnabled, localDirectTapbackEnabled, localDirectReplyEnabled, localMultihopEnabled, localMultihopTapbackEnabled, localMultihopReplyEnabled, testMessages, enabled, regex, message, messageDirect, enabledChannels, directMessagesEnabled, useDM, skipIncompleteNodes, tapbackEnabled, replyEnabled, directEnabled, directTapbackEnabled, directReplyEnabled, multihopEnabled, multihopTapbackEnabled, multihopReplyEnabled, testMessagesProp]);

  // Reset local state to props (used by SaveBar dismiss)
  const resetChanges = useCallback(() => {
    setLocalEnabled(enabled);
    setLocalRegex(regex || '^(test|ping)');
    setLocalMessage(message || DEFAULT_MESSAGE);
    setLocalMessageDirect(messageDirect || DEFAULT_MESSAGE_DIRECT);
    setLocalEnabledChannels(enabledChannels);
    setLocalDirectMessagesEnabled(directMessagesEnabled);
    setLocalUseDM(useDM);
    setLocalSkipIncompleteNodes(skipIncompleteNodes);
    setLocalTapbackEnabled(tapbackEnabled);
    setLocalReplyEnabled(replyEnabled);
    setLocalDirectEnabled(directEnabled);
    setLocalDirectTapbackEnabled(directTapbackEnabled);
    setLocalDirectReplyEnabled(directReplyEnabled);
    setLocalMultihopEnabled(multihopEnabled);
    setLocalMultihopTapbackEnabled(multihopTapbackEnabled);
    setLocalMultihopReplyEnabled(multihopReplyEnabled);
    setTestMessages(testMessagesProp || 'test\nTest message\nping\nPING\nHello world\nTESTING 123');
  }, [enabled, regex, message, messageDirect, enabledChannels, directMessagesEnabled, useDM, skipIncompleteNodes, tapbackEnabled, replyEnabled, directEnabled, directTapbackEnabled, directReplyEnabled, multihopEnabled, multihopTapbackEnabled, multihopReplyEnabled, testMessagesProp]);

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

    return sample;
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
      const response = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoAckEnabled: String(localEnabled),
          autoAckRegex: localRegex,
          autoAckMessage: localMessage,
          autoAckMessageDirect: localMessageDirect,
          autoAckChannels: localEnabledChannels.join(','),
          autoAckDirectMessages: String(localDirectMessagesEnabled),
          autoAckUseDM: String(localUseDM),
          autoAckSkipIncompleteNodes: String(localSkipIncompleteNodes),
          autoAckTapbackEnabled: String(localTapbackEnabled),
          autoAckReplyEnabled: String(localReplyEnabled),
          autoAckDirectEnabled: String(localDirectEnabled),
          autoAckDirectTapbackEnabled: String(localDirectTapbackEnabled),
          autoAckDirectReplyEnabled: String(localDirectReplyEnabled),
          autoAckMultihopEnabled: String(localMultihopEnabled),
          autoAckMultihopTapbackEnabled: String(localMultihopTapbackEnabled),
          autoAckMultihopReplyEnabled: String(localMultihopReplyEnabled),
          autoAckTestMessages: testMessages
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          showToast(t('automation.insufficient_permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${response.status}`);
      }

      // Only update parent state after successful API call (no localStorage)
      onEnabledChange(localEnabled);
      onRegexChange(localRegex);
      onMessageChange(localMessage);
      onMessageDirectChange(localMessageDirect);
      onChannelsChange(localEnabledChannels);
      onDirectMessagesChange(localDirectMessagesEnabled);
      onUseDMChange(localUseDM);
      onSkipIncompleteNodesChange(localSkipIncompleteNodes);
      onTapbackEnabledChange(localTapbackEnabled);
      onReplyEnabledChange(localReplyEnabled);
      onDirectEnabledChange(localDirectEnabled);
      onDirectTapbackEnabledChange(localDirectTapbackEnabled);
      onDirectReplyEnabledChange(localDirectReplyEnabled);
      onMultihopEnabledChange(localMultihopEnabled);
      onMultihopTapbackEnabledChange(localMultihopTapbackEnabled);
      onMultihopReplyEnabledChange(localMultihopReplyEnabled);
      onTestMessagesChange(testMessages);

      setHasChanges(false);
      showToast(t('automation.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-acknowledge settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [localRegex, localEnabled, localMessage, localMessageDirect, localEnabledChannels, localDirectMessagesEnabled, localUseDM, localSkipIncompleteNodes, localTapbackEnabled, localReplyEnabled, localDirectEnabled, localDirectTapbackEnabled, localDirectReplyEnabled, localMultihopEnabled, localMultihopTapbackEnabled, localMultihopReplyEnabled, testMessages, baseUrl, csrfFetch, showToast, t, onEnabledChange, onRegexChange, onMessageChange, onMessageDirectChange, onChannelsChange, onDirectMessagesChange, onUseDMChange, onSkipIncompleteNodesChange, onTapbackEnabledChange, onReplyEnabledChange, onDirectEnabledChange, onDirectTapbackEnabledChange, onDirectReplyEnabledChange, onMultihopEnabledChange, onMultihopTapbackEnabledChange, onMultihopReplyEnabledChange, onTestMessagesChange]);

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
            ❓
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
                {t('automation.auto_ack.direct_messages')}
              </label>
            </div>
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
            {t('automation.auto_ack.response_delivery')}
            <span className="setting-description">
              {t('automation.auto_ack.response_delivery_description')}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="autoAckUseDM"
              checked={localUseDM}
              onChange={(e) => setLocalUseDM(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoAckUseDM" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
              {t('automation.auto_ack.always_respond_dm')}
            </label>
          </div>
          <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t('automation.auto_ack.always_respond_dm_description')}
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
        </div>

        {/* Direct Messages Section (0 hops) */}
        <div className="setting-item" style={{
          marginTop: '1.5rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '2px solid var(--ctp-green)',
          borderRadius: '8px',
          opacity: localEnabled ? 1 : 0.5
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <input
              type="checkbox"
              id="autoAckDirectEnabled"
              checked={localDirectEnabled}
              onChange={(e) => setLocalDirectEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoAckDirectEnabled" style={{ margin: 0, fontWeight: 'bold', fontSize: '1.1rem' }}>
              {t('automation.auto_ack.direct_section')}
            </label>
          </div>
          <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)', marginLeft: '1.75rem' }}>
            {t('automation.auto_ack.direct_section_description')}
          </p>

          <div style={{ marginLeft: '1.75rem', opacity: localDirectEnabled ? 1 : 0.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                id="autoAckDirectTapback"
                checked={localDirectTapbackEnabled}
                onChange={(e) => setLocalDirectTapbackEnabled(e.target.checked)}
                disabled={!localEnabled || !localDirectEnabled}
                style={{ width: 'auto', margin: 0, cursor: (localEnabled && localDirectEnabled) ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckDirectTapback" style={{ margin: 0, cursor: (localEnabled && localDirectEnabled) ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.tapback_with_hop_count')}
              </label>
              <span style={{ marginLeft: '0.5rem', fontSize: '1.2rem' }} title="Direct (0 hops)">*️⃣</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                type="checkbox"
                id="autoAckDirectReply"
                checked={localDirectReplyEnabled}
                onChange={(e) => setLocalDirectReplyEnabled(e.target.checked)}
                disabled={!localEnabled || !localDirectEnabled}
                style={{ width: 'auto', margin: 0, cursor: (localEnabled && localDirectEnabled) ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckDirectReply" style={{ margin: 0, cursor: (localEnabled && localDirectEnabled) ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.reply_with_message')}
              </label>
            </div>

            {localDirectReplyEnabled && (
              <>
                <label htmlFor="autoAckMessageDirect" style={{ display: 'block', marginBottom: '0.5rem' }}>
                  {t('automation.auto_ack.message_direct')}
                  <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                    {t('automation.auto_ack.available_tokens')} {'{NODE_ID}'}, {'{SNR}'}, {'{RSSI}'}, {'{DATE}'}, {'{TIME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{TOTALNODES}'}, {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{TRANSPORT}'}
                  </span>
                </label>
                <textarea
                  id="autoAckMessageDirect"
                  ref={textareaDirectRef}
                  value={localMessageDirect}
                  onChange={(e) => setLocalMessageDirect(e.target.value)}
                  disabled={!localEnabled || !localDirectEnabled || !localDirectReplyEnabled}
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
              </>
            )}
          </div>
        </div>

        {/* Multi-hop Messages Section (1+ hops) */}
        <div className="setting-item" style={{
          marginTop: '1.5rem',
          padding: '1rem',
          background: 'var(--ctp-surface0)',
          border: '2px solid var(--ctp-blue)',
          borderRadius: '8px',
          opacity: localEnabled ? 1 : 0.5
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <input
              type="checkbox"
              id="autoAckMultihopEnabled"
              checked={localMultihopEnabled}
              onChange={(e) => setLocalMultihopEnabled(e.target.checked)}
              disabled={!localEnabled}
              style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
            />
            <label htmlFor="autoAckMultihopEnabled" style={{ margin: 0, fontWeight: 'bold', fontSize: '1.1rem' }}>
              {t('automation.auto_ack.multihop_section')}
            </label>
          </div>
          <p style={{ marginBottom: '1rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)', marginLeft: '1.75rem' }}>
            {t('automation.auto_ack.multihop_section_description')}
          </p>

          <div style={{ marginLeft: '1.75rem', opacity: localMultihopEnabled ? 1 : 0.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="checkbox"
                id="autoAckMultihopTapback"
                checked={localMultihopTapbackEnabled}
                onChange={(e) => setLocalMultihopTapbackEnabled(e.target.checked)}
                disabled={!localEnabled || !localMultihopEnabled}
                style={{ width: 'auto', margin: 0, cursor: (localEnabled && localMultihopEnabled) ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckMultihopTapback" style={{ margin: 0, cursor: (localEnabled && localMultihopEnabled) ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.tapback_with_hop_count')}
              </label>
              <div style={{ marginLeft: '0.5rem', display: 'flex', gap: '0.15rem' }}>
                {HOP_COUNT_EMOJIS.slice(1).map((emoji, idx) => (
                  <span key={idx} title={`${idx + 1} hop${idx > 0 ? 's' : ''}`} style={{ fontSize: '1rem' }}>
                    {emoji}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                type="checkbox"
                id="autoAckMultihopReply"
                checked={localMultihopReplyEnabled}
                onChange={(e) => setLocalMultihopReplyEnabled(e.target.checked)}
                disabled={!localEnabled || !localMultihopEnabled}
                style={{ width: 'auto', margin: 0, cursor: (localEnabled && localMultihopEnabled) ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckMultihopReply" style={{ margin: 0, cursor: (localEnabled && localMultihopEnabled) ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.reply_with_message')}
              </label>
            </div>

            {localMultihopReplyEnabled && (
              <>
                <label htmlFor="autoAckMessage" style={{ display: 'block', marginBottom: '0.5rem' }}>
                  {t('automation.auto_ack.message_multihop')}
                  <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
                    {t('automation.auto_ack.available_tokens')} {'{NODE_ID}'}, {'{NUMBER_HOPS}'}, {'{HOPS}'}, {'{RABBIT_HOPS}'}, {'{DATE}'}, {'{TIME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{TOTALNODES}'}, {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{SNR}'}, {'{RSSI}'}, {'{TRANSPORT}'}
                  </span>
                </label>
                <textarea
                  id="autoAckMessage"
                  ref={textareaRef}
                  value={localMessage}
                  onChange={(e) => setLocalMessage(e.target.value)}
                  disabled={!localEnabled || !localMultihopEnabled || !localMultihopReplyEnabled}
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
              </>
            )}
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
