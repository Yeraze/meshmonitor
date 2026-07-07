import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { ScopeSelectField, type ScopeMode } from './ScopeSelectField';

interface MeshCoreAutoAckSectionProps {
  baseUrl: string;
  sourceId: string;
}

interface AutoAckSettings {
  enabled: boolean;
  regex: string;
  message: string;
  channels: number[];
  directMessages: boolean;
  useDM: boolean;
  cooldownSeconds: number;
  /** Pre-send delay (seconds) before the ack reply is sent (#3876). */
  preSendDelaySeconds: number;
  testMessages: string;
  /** MeshCore scope/region for the ack reply (#3833). */
  scopeMode: ScopeMode;
  scopeName: string;
}

interface MeshCoreChannelRow {
  id: number;
  name: string;
}

const DEFAULT_MESSAGE = '🤖 Copy, {NODE_NAME}! {HOPS} hops @ {TIME}';
const DEFAULT_REGEX = '^(test|ping)';
const DEFAULT_TEST_MESSAGES = 'test\nTest message\nping\nPING\nHello world\nTESTING 123';

const DEFAULTS: AutoAckSettings = {
  enabled: false,
  regex: DEFAULT_REGEX,
  message: DEFAULT_MESSAGE,
  channels: [],
  directMessages: true,
  useDM: false,
  cooldownSeconds: 0,
  preSendDelaySeconds: 0,
  testMessages: DEFAULT_TEST_MESSAGES,
  scopeMode: 'inherit',
  scopeName: '',
};

const validateRegex = (pattern: string): { valid: boolean; error?: string } => {
  if (pattern.length > 100) return { valid: false, error: 'Pattern too long (max 100 chars)' };
  if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
    return { valid: false, error: 'Pattern too complex (possible ReDoS)' };
  }
  try {
    new RegExp(pattern, 'i');
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid regex syntax' };
  }
};

const generateSample = (template: string): string => {
  const now = new Date();
  return template
    .replace(/\{NODE_ID\}/g, '!a1b2c3d4')
    .replace(/\{NODE_NAME\}/g, 'Alice MeshCore')
    .replace(/\{LONG_NAME\}/g, 'Alice MeshCore')
    .replace(/\{SHORT_NAME\}/g, 'Alic')
    .replace(/\{DATE\}/g, now.toLocaleDateString('en-US'))
    .replace(/\{TIME\}/g, now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
    .replace(/\{SNR\}/g, '7.5')
    .replace(/\{HOPS\}/g, '3')
    .replace(/\{NUMBER_HOPS\}/g, '3')
    .replace(/\{ROUTE\}/g, 'a3 → 7f → 02')
    .replace(/\{VERSION\}/g, '4.8.0');
};

export const MeshCoreAutoAckSection: React.FC<MeshCoreAutoAckSectionProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<AutoAckSettings>(DEFAULTS);
  const [initial, setInitial] = useState<AutoAckSettings>(DEFAULTS);
  const [channels, setChannels] = useState<MeshCoreChannelRow[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load auto-ack settings
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/autoack`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json.success || !json.data) return;
        const s: AutoAckSettings = {
          enabled: !!json.data.enabled,
          regex: json.data.regex || DEFAULT_REGEX,
          message: json.data.message || DEFAULT_MESSAGE,
          channels: Array.isArray(json.data.channels) ? json.data.channels : [],
          directMessages: !!json.data.directMessages,
          useDM: !!json.data.useDM,
          cooldownSeconds: typeof json.data.cooldownSeconds === 'number' ? json.data.cooldownSeconds : 0,
          preSendDelaySeconds: typeof json.data.preSendDelaySeconds === 'number' ? json.data.preSendDelaySeconds : 0,
          testMessages: json.data.testMessages || DEFAULT_TEST_MESSAGES,
          scopeMode: (json.data.scopeMode as ScopeMode) || 'inherit',
          scopeName: json.data.scopeName || '',
        };
        setSettings(s);
        setInitial(s);
        setLoaded(true);
      } catch {
        // ignore — keep defaults
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Load channels for the per-channel allowlist
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(
          `${baseUrl}/api/channels/all?sourceId=${encodeURIComponent(sourceId)}`,
        );
        if (!res.ok) return;
        const raw = await res.json();
        if (cancelled) return;
        const rows: MeshCoreChannelRow[] = Array.isArray(raw)
          ? raw
              .filter((c: any) => typeof c?.id === 'number')
              .map((c: any) => ({ id: c.id as number, name: String(c.name ?? '') }))
              .sort((a, b) => a.id - b.id)
          : [];
        setChannels(rows);
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Detect changes
  useEffect(() => {
    if (!loaded) return;
    const channelsChanged = JSON.stringify([...settings.channels].sort()) !== JSON.stringify([...initial.channels].sort());
    setHasChanges(
      settings.enabled !== initial.enabled ||
      settings.regex !== initial.regex ||
      settings.message !== initial.message ||
      settings.directMessages !== initial.directMessages ||
      settings.useDM !== initial.useDM ||
      settings.cooldownSeconds !== initial.cooldownSeconds ||
      settings.preSendDelaySeconds !== initial.preSendDelaySeconds ||
      settings.testMessages !== initial.testMessages ||
      settings.scopeMode !== initial.scopeMode ||
      settings.scopeName !== initial.scopeName ||
      channelsChanged,
    );
  }, [settings, initial, loaded]);

  const handleSave = useCallback(async () => {
    const validation = validateRegex(settings.regex);
    if (!validation.valid) {
      showToast(`Invalid regex pattern: ${validation.error}`, 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/autoack`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: settings.enabled,
            regex: settings.regex,
            message: settings.message,
            channels: settings.channels,
            directMessages: settings.directMessages,
            useDM: settings.useDM,
            cooldownSeconds: settings.cooldownSeconds,
            preSendDelaySeconds: settings.preSendDelaySeconds,
            testMessages: settings.testMessages,
            scopeMode: settings.scopeMode,
            scopeName: settings.scopeName,
          }),
        },
      );
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${res.status}`);
      }
      setInitial(settings);
      setHasChanges(false);
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-ack settings:', err);
      showToast(t('automation.settings_save_failed', 'Failed to save settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  }, [settings, baseUrl, sourceId, csrfFetch, showToast, t]);

  const handleDismiss = useCallback(() => {
    setSettings(initial);
    setHasChanges(false);
  }, [initial]);

  useSaveBar({
    id: 'meshcore-auto-ack',
    sectionName: t('meshcore.automation.autoack.title', 'Auto-Acknowledge'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof AutoAckSettings>(key: K, value: AutoAckSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const sample = useMemo(() => generateSample(settings.message), [settings.message]);

  const testRegex = useMemo(() => {
    const v = validateRegex(settings.regex);
    return v.valid ? new RegExp(settings.regex, 'i') : null;
  }, [settings.regex]);

  const disabled = !settings.enabled;

  return (
    <>
      <div className="automation-section-header" style={{
        display: 'flex',
        alignItems: 'center',
        marginBottom: '1.5rem',
        marginTop: '2rem',
        padding: '1rem 1.25rem',
        background: 'var(--ctp-surface1)',
        border: '1px solid var(--ctp-surface2)',
        borderRadius: '8px',
      }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
            disabled={!canWrite}
            style={{ width: 'auto', margin: 0, cursor: canWrite ? 'pointer' : 'not-allowed' }}
          />
          {t('meshcore.automation.autoack.title', 'Auto-Acknowledge')}
        </h2>
      </div>

      <div className="settings-section" style={{ opacity: settings.enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: 1.5, marginLeft: '1.75rem' }}>
          {t(
            'meshcore.automation.autoack.description',
            'Automatically reply to incoming MeshCore messages that match a regex pattern. Supports per-channel allowlist, DM trigger, and template macros.',
          )}
        </p>

        {/* Regex */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label htmlFor="meshcoreAutoAckRegex">
            {t('meshcore.automation.autoack.regex_label', 'Trigger Pattern (regex)')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.regex_description',
                'Incoming messages that match this case-insensitive regex trigger an acknowledgement.',
              )}{' '}
              {t('meshcore.automation.autoack.regex_default', 'Default: ^(test|ping)')}
            </span>
          </label>
          <input
            id="meshcoreAutoAckRegex"
            type="text"
            value={settings.regex}
            onChange={(e) => update('regex', e.target.value)}
            placeholder={DEFAULT_REGEX}
            disabled={disabled || !canWrite}
            className="setting-input"
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        {/* Channel selection */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.autoack.active_channels', 'Active Channels')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.active_channels_description',
                'Acknowledge messages received on these channels. Direct Messages can be toggled separately below.',
              )}
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                id="meshcoreAutoAckDM"
                checked={settings.directMessages}
                onChange={(e) => update('directMessages', e.target.checked)}
                disabled={disabled || !canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="meshcoreAutoAckDM" style={{ margin: 0, fontWeight: 'bold' }}>
                {t('meshcore.automation.autoack.direct_messages', 'Direct Messages')}
              </label>
            </div>
            {channels.length === 0 && (
              <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginLeft: '1.5rem' }}>
                {t('meshcore.automation.autoack.no_channels', 'No channels loaded yet.')}
              </div>
            )}
            {channels.map((channel) => (
              <div key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id={`meshcoreAutoAckChannel${channel.id}`}
                  checked={settings.channels.includes(channel.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      update('channels', [...settings.channels, channel.id]);
                    } else {
                      update('channels', settings.channels.filter((c) => c !== channel.id));
                    }
                  }}
                  disabled={disabled || !canWrite}
                  style={{ width: 'auto', margin: 0 }}
                />
                <label
                  htmlFor={`meshcoreAutoAckChannel${channel.id}`}
                  style={{ margin: 0 }}
                >
                  {channel.name || `Channel ${channel.id}`}
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* Always respond via DM */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.autoack.response_delivery', 'Response Delivery')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.response_delivery_description',
                'Control whether the acknowledgement is sent on the originating channel or always as a DM.',
              )}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="meshcoreAutoAckUseDM"
              checked={settings.useDM}
              onChange={(e) => update('useDM', e.target.checked)}
              disabled={disabled || !canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <label htmlFor="meshcoreAutoAckUseDM" style={{ margin: 0, fontWeight: 'bold' }}>
              {t('meshcore.automation.autoack.always_respond_dm', 'Always respond via DM')}
            </label>
          </div>
          <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
            {t(
              'meshcore.automation.autoack.always_respond_dm_description',
              'When enabled, replies are always sent as a DM to the sender, even when the trigger came from a channel. Requires the sender to be in your contact list.',
            )}
          </div>
        </div>

        {/* Cooldown */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.autoack.cooldown_label', 'Per-Sender Cooldown')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.cooldown_description',
                'Minimum seconds between acknowledgements for the same sender. 0 disables the cooldown.',
              )}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="number"
              value={settings.cooldownSeconds}
              onChange={(e) => update('cooldownSeconds', Math.max(0, parseInt(e.target.value, 10) || 0))}
              min={0}
              max={3600}
              disabled={disabled || !canWrite}
              style={{ width: '100px', padding: '2px 4px' }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.autoack.cooldown_help', 'seconds (0 = no cooldown)')}
            </span>
          </div>
        </div>

        {/* Pre-send delay (#3876) — wait before replying so a repeater can finish its TX. */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.autoack.presend_delay_label', 'Pre-Send Delay')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.presend_delay_description',
                'Wait this many seconds before sending the reply. Gives a repeater time to finish its own transmission so a zero-hop ack is not dropped. 0 sends immediately.',
              )}
            </span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="number"
              value={settings.preSendDelaySeconds}
              onChange={(e) => update('preSendDelaySeconds', Math.max(0, Math.min(120, parseInt(e.target.value, 10) || 0)))}
              min={0}
              max={120}
              disabled={disabled || !canWrite}
              style={{ width: '100px', padding: '2px 4px' }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.autoack.presend_delay_help', 'seconds (0 = send immediately, max 120)')}
            </span>
          </div>
        </div>

        {/* MeshCore scope/region for the ack reply (#3833) */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.autoack.scope_label', 'Reply Scope')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.scope_description',
                'Region the acknowledgement floods to. "Respond on the triggering message\'s scope" replies in the same region the request arrived on.',
              )}
            </span>
          </label>
          <div style={{ marginTop: '0.5rem' }}>
            <ScopeSelectField
              baseUrl={baseUrl}
              sourceId={sourceId}
              allowTrigger
              idPrefix="autoack"
              value={{ scopeMode: settings.scopeMode, scopeName: settings.scopeName }}
              onChange={(v) => setSettings((s) => ({ ...s, scopeMode: v.scopeMode ?? 'inherit', scopeName: v.scopeName ?? '' }))}
            />
          </div>
        </div>

        {/* Message template */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="meshcoreAutoAckMessage">
            {t('meshcore.automation.autoack.message_label', 'Acknowledgement Message')}
            <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
              {t('meshcore.automation.autoack.tokens_hint', 'Supports message tokens — see the reference at the top of this page.')}
            </span>
          </label>
          <textarea
            id="meshcoreAutoAckMessage"
            ref={textareaRef}
            value={settings.message}
            onChange={(e) => update('message', e.target.value)}
            disabled={disabled || !canWrite}
            className="setting-input"
            rows={3}
            style={{ fontFamily: 'monospace', resize: 'vertical', minHeight: '60px' }}
          />
          <div style={{ marginTop: '0.5rem' }}>
            <label style={{ fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.autoack.sample_preview', 'Sample preview')}:
            </label>
            <div style={{
              marginTop: '0.25rem',
              padding: '0.5rem',
              background: 'var(--ctp-base)',
              border: '1px solid var(--ctp-blue)',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.9rem',
              color: 'var(--ctp-text)',
            }}>
              {sample}
            </div>
          </div>
        </div>

        {/* Regex test */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="meshcoreAutoAckTestMessages">
            {t('meshcore.automation.autoack.pattern_testing', 'Pattern Testing')}
            <span className="setting-description">
              {t(
                'meshcore.automation.autoack.pattern_testing_description',
                'One message per line. Green means the pattern would match (acknowledge); red means it would not.',
              )}
            </span>
          </label>
          <div className="auto-ack-test-container">
            <div>
              <textarea
                id="meshcoreAutoAckTestMessages"
                value={settings.testMessages}
                onChange={(e) => update('testMessages', e.target.value)}
                placeholder={t(
                  'meshcore.automation.autoack.test_placeholder',
                  'Enter test messages, one per line',
                )}
                disabled={disabled || !canWrite}
                className="setting-input"
                rows={6}
                style={{
                  fontFamily: 'monospace',
                  resize: 'vertical',
                  minHeight: '120px',
                  width: '100%',
                }}
              />
            </div>
            <div>
              {settings.testMessages
                .split('\n')
                .filter((line) => line.trim())
                .map((message, index) => {
                  const matches = testRegex ? testRegex.test(message) : false;
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
                        lineHeight: '1.3',
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
                          flexShrink: 0,
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

export default MeshCoreAutoAckSection;
