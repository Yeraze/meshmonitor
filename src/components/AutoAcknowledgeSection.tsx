import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from './ToastContainer';
import { useCsrfFetch } from '../hooks/useCsrfFetch';
import { Channel } from '../types/device';

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
}) => {
  const { t } = useTranslation();
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
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testMessages, setTestMessages] = useState('test\nTest message\nping\nPING\nHello world\nTESTING 123');
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
  }, [enabled, regex, message, messageDirect, enabledChannels, directMessagesEnabled, useDM, skipIncompleteNodes, tapbackEnabled, replyEnabled]);

  // Check if any settings have changed
  useEffect(() => {
    const channelsChanged = JSON.stringify(localEnabledChannels.sort()) !== JSON.stringify(enabledChannels.sort());
    const changed = localEnabled !== enabled || localRegex !== regex || localMessage !== message || localMessageDirect !== messageDirect || channelsChanged || localDirectMessagesEnabled !== directMessagesEnabled || localUseDM !== useDM || localSkipIncompleteNodes !== skipIncompleteNodes || localTapbackEnabled !== tapbackEnabled || localReplyEnabled !== replyEnabled;
    setHasChanges(changed);
  }, [localEnabled, localRegex, localMessage, localMessageDirect, localEnabledChannels, localDirectMessagesEnabled, localUseDM, localSkipIncompleteNodes, localTapbackEnabled, localReplyEnabled, enabled, regex, message, messageDirect, enabledChannels, directMessagesEnabled, useDM, skipIncompleteNodes, tapbackEnabled, replyEnabled]);

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

  const insertToken = (token: string, isDirect: boolean = false) => {
    const textarea = isDirect ? textareaDirectRef.current : textareaRef.current;
    const currentMessage = isDirect ? localMessageDirect : localMessage;
    const setMessage = isDirect ? setLocalMessageDirect : setLocalMessage;

    if (!textarea) {
      // Fallback: append to end if textarea ref not available
      setMessage(currentMessage + token);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newMessage = currentMessage.substring(0, start) + token + currentMessage.substring(end);

    setMessage(newMessage);

    // Set cursor position after the inserted token
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    }, 0);
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
    sample = sample.replace(/{DATE}/g, now.toLocaleDateString());
    sample = sample.replace(/{TIME}/g, now.toLocaleTimeString());
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
    sample = sample.replace(/{SNR}/g, '7.5');
    sample = sample.replace(/{RSSI}/g, '-95');

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
          autoAckMessageDirect: localMessageDirect,
          autoAckChannels: localEnabledChannels.join(','),
          autoAckDirectMessages: String(localDirectMessagesEnabled),
          autoAckUseDM: String(localUseDM),
          autoAckSkipIncompleteNodes: String(localSkipIncompleteNodes),
          autoAckTapbackEnabled: String(localTapbackEnabled),
          autoAckReplyEnabled: String(localReplyEnabled)
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

      setHasChanges(false);
      showToast(t('automation.settings_saved'), 'success');
    } catch (error) {
      console.error('Failed to save auto-acknowledge settings:', error);
      showToast(t('automation.settings_save_failed'), 'error');
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
          {isSaving ? t('automation.saving') : t('automation.save_changes')}
        </button>
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

        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('automation.auto_ack.response_type')}
            <span className="setting-description">
              {t('automation.auto_ack.response_type_description')}
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="autoAckTapback"
                checked={localTapbackEnabled}
                onChange={(e) => setLocalTapbackEnabled(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckTapback" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.tapback_with_hop_count')}
              </label>
            </div>
            <div style={{ marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.tapback_with_hop_count_description')}
              <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ marginRight: '0.5rem' }}>{t('automation.auto_ack.hop_emojis')}:</span>
                {HOP_COUNT_EMOJIS.map((emoji, idx) => (
                  <span key={idx} title={idx === 0 ? 'Direct (0 hops)' : `${idx} hop${idx > 1 ? 's' : ''}`} style={{ fontSize: '1.2rem' }}>
                    {emoji}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                type="checkbox"
                id="autoAckReply"
                checked={localReplyEnabled}
                onChange={(e) => setLocalReplyEnabled(e.target.checked)}
                disabled={!localEnabled}
                style={{ width: 'auto', margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed' }}
              />
              <label htmlFor="autoAckReply" style={{ margin: 0, cursor: localEnabled ? 'pointer' : 'not-allowed', fontWeight: 'bold' }}>
                {t('automation.auto_ack.reply_with_message')}
              </label>
            </div>
            <div style={{ marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('automation.auto_ack.reply_with_message_description')}
            </div>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem', opacity: localReplyEnabled ? 1 : 0.5 }}>
          <label htmlFor="autoAckMessage">
            {t('automation.auto_ack.message_multihop')}
            <span className="setting-description">
              {t('automation.auto_ack.message_multihop_description')} {t('automation.auto_ack.available_tokens')} {'{NODE_ID}'}, {'{NUMBER_HOPS}'}, {'{HOPS}'}, {'{RABBIT_HOPS}'}, {'{DATE}'}, {'{TIME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{SNR}'}, {'{RSSI}'}
            </span>
          </label>
          <textarea
            id="autoAckMessage"
            ref={textareaRef}
            value={localMessage}
            onChange={(e) => setLocalMessage(e.target.value)}
            disabled={!localEnabled || !localReplyEnabled}
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
              onClick={() => insertToken('{DATE}')}
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
              + {'{DATE}'}
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
            <button
              type="button"
              onClick={() => insertToken('{SNR}')}
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
              + {'{SNR}'}
            </button>
            <button
              type="button"
              onClick={() => insertToken('{RSSI}')}
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
              + {'{RSSI}'}
            </button>
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.auto_ack.sample_preview_multihop')}
            <span className="setting-description">
              {t('automation.auto_ack.sample_preview_multihop_description')}
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
            {generateSampleMessage(false)}
          </div>
        </div>

        <div className="setting-item" style={{ marginTop: '1.5rem', opacity: localReplyEnabled ? 1 : 0.5 }}>
          <label htmlFor="autoAckMessageDirect">
            {t('automation.auto_ack.message_direct')}
            <span className="setting-description">
              {t('automation.auto_ack.message_direct_description')} {t('automation.auto_ack.available_tokens')} {'{NODE_ID}'}, {'{HOPS}'}, {'{NUMBER_HOPS}'}, {'{RABBIT_HOPS}'}, {'{DATE}'}, {'{TIME}'}, {'{VERSION}'}, {'{DURATION}'}, {'{FEATURES}'}, {'{NODECOUNT}'}, {'{DIRECTCOUNT}'}, {'{LONG_NAME}'}, {'{SHORT_NAME}'}, {'{SNR}'}, {'{RSSI}'}
            </span>
          </label>
          <textarea
            id="autoAckMessageDirect"
            ref={textareaDirectRef}
            value={localMessageDirect}
            onChange={(e) => setLocalMessageDirect(e.target.value)}
            disabled={!localEnabled || !localReplyEnabled}
            className="setting-input"
            rows={3}
            style={{
              fontFamily: 'monospace',
              resize: 'vertical',
              minHeight: '60px'
            }}
          />
        </div>

        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label>
            {t('automation.auto_ack.sample_preview_direct')}
            <span className="setting-description">
              {t('automation.auto_ack.sample_preview_direct_description')}
            </span>
          </label>
          <div style={{
            padding: '0.75rem',
            background: 'var(--ctp-surface0)',
            border: '2px solid var(--ctp-green)',
            borderRadius: '4px',
            fontFamily: 'monospace',
            fontSize: '0.95rem',
            color: 'var(--ctp-text)',
            lineHeight: '1.5',
            minHeight: '50px'
          }}>
            {generateSampleMessage(true)}
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
