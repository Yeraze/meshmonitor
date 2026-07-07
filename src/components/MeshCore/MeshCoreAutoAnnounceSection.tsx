import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidCron } from 'cron-validator';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../ToastContainer';
import { useAuth } from '../../contexts/AuthContext';
import { useSaveBar } from '../../hooks/useSaveBar';
import { ScopeSelectField, type ScopeMode } from './ScopeSelectField';
import { MESHCORE_AUTOMATION_TOKENS } from './meshcoreAutomationTokens';

interface MeshCoreAutoAnnounceSectionProps {
  baseUrl: string;
  sourceId: string;
}

interface AutoAnnounceSettings {
  enabled: boolean;
  intervalHours: number;
  message: string;
  channelIndexes: number[];
  announceOnStart: boolean;
  useSchedule: boolean;
  schedule: string;
  advertEnabled: boolean;
  advertDelaySeconds: number;
  /** MeshCore scope/region for the announcement (#3833). No trigger, so no 'trigger' mode. */
  scopeMode: ScopeMode;
  scopeName: string;
}

interface MeshCoreChannelRow {
  id: number;
  name: string;
}

const DEFAULT_MESSAGE = 'MeshMonitor {VERSION} online for {DURATION} — {CONTACTCOUNT} contacts';
const DEFAULT_SCHEDULE = '0 */6 * * *';

const DEFAULTS: AutoAnnounceSettings = {
  enabled: false,
  intervalHours: 6,
  message: DEFAULT_MESSAGE,
  channelIndexes: [0],
  announceOnStart: false,
  useSchedule: false,
  schedule: DEFAULT_SCHEDULE,
  advertEnabled: false,
  advertDelaySeconds: 30,
  scopeMode: 'inherit',
  scopeName: '',
};

const TOKENS = MESHCORE_AUTOMATION_TOKENS;

const arraysEqual = (a: number[], b: number[]): boolean => {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort((x, y) => x - y);
  const bSorted = [...b].sort((x, y) => x - y);
  return aSorted.every((v, i) => v === bSorted[i]);
};

export const MeshCoreAutoAnnounceSection: React.FC<MeshCoreAutoAnnounceSectionProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('automation', 'write');

  const [settings, setSettings] = useState<AutoAnnounceSettings>(DEFAULTS);
  const [initial, setInitial] = useState<AutoAnnounceSettings>(DEFAULTS);
  const [channels, setChannels] = useState<MeshCoreChannelRow[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string>('');
  const [isSendingNow, setIsSendingNow] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load settings
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/announce`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled || !json.success || !json.data) return;
        const s: AutoAnnounceSettings = {
          enabled: !!json.data.enabled,
          intervalHours: typeof json.data.intervalHours === 'number' ? json.data.intervalHours : 6,
          message: json.data.message || DEFAULT_MESSAGE,
          channelIndexes: Array.isArray(json.data.channelIndexes) ? json.data.channelIndexes : [0],
          announceOnStart: !!json.data.announceOnStart,
          useSchedule: !!json.data.useSchedule,
          schedule: json.data.schedule || DEFAULT_SCHEDULE,
          advertEnabled: !!json.data.advertEnabled,
          advertDelaySeconds: typeof json.data.advertDelaySeconds === 'number' ? json.data.advertDelaySeconds : 30,
          scopeMode: (json.data.scopeMode as ScopeMode) || 'inherit',
          scopeName: json.data.scopeName || '',
        };
        setSettings(s);
        setInitial(s);
        setLastRunAt(typeof json.data.lastRunAt === 'number' ? json.data.lastRunAt : null);
        setLoaded(true);
      } catch {
        // keep defaults
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, sourceId, csrfFetch]);

  // Load channels
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

  // Live preview (debounced)
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const url = `${baseUrl}/api/sources/${sourceId}/meshcore/automation/announce/preview?message=${encodeURIComponent(settings.message)}`;
        const res = await csrfFetch(url);
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled && json.success) setPreview(json.preview || '');
      } catch {
        // leave previous preview
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [settings.message, baseUrl, sourceId, csrfFetch]);

  // Detect changes
  useEffect(() => {
    if (!loaded) return;
    setHasChanges(
      settings.enabled !== initial.enabled ||
      settings.intervalHours !== initial.intervalHours ||
      settings.message !== initial.message ||
      !arraysEqual(settings.channelIndexes, initial.channelIndexes) ||
      settings.announceOnStart !== initial.announceOnStart ||
      settings.useSchedule !== initial.useSchedule ||
      settings.schedule !== initial.schedule ||
      settings.advertEnabled !== initial.advertEnabled ||
      settings.advertDelaySeconds !== initial.advertDelaySeconds ||
      settings.scopeMode !== initial.scopeMode ||
      settings.scopeName !== initial.scopeName,
    );
  }, [settings, initial, loaded]);

  // Validate cron when in schedule mode
  useEffect(() => {
    if (!settings.useSchedule) {
      setScheduleError(null);
      return;
    }
    const valid = isValidCron(settings.schedule, { seconds: false, alias: true, allowBlankDay: true });
    setScheduleError(valid ? null : t('meshcore.automation.announce.invalid_cron', 'Invalid cron expression'));
  }, [settings.useSchedule, settings.schedule, t]);

  const handleSave = useCallback(async () => {
    if (settings.useSchedule && !isValidCron(settings.schedule, { seconds: false, alias: true, allowBlankDay: true })) {
      showToast(t('meshcore.automation.announce.invalid_cron', 'Invalid cron expression'), 'error');
      return;
    }
    setIsSaving(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/announce`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: settings.enabled,
            intervalHours: settings.intervalHours,
            message: settings.message,
            channelIndexes: settings.channelIndexes,
            announceOnStart: settings.announceOnStart,
            useSchedule: settings.useSchedule,
            schedule: settings.schedule,
            advertEnabled: settings.advertEnabled,
            advertDelaySeconds: settings.advertDelaySeconds,
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
      const json = await res.json();
      setInitial(settings);
      setHasChanges(false);
      if (typeof json?.data?.lastRunAt === 'number') setLastRunAt(json.data.lastRunAt);
      showToast(t('automation.settings_saved', 'Settings saved'), 'success');
    } catch (err) {
      console.error('Failed to save MeshCore auto-announce settings:', err);
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
    id: 'meshcore-auto-announce',
    sectionName: t('meshcore.automation.announce.title', 'Auto-Announce'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof AutoAnnounceSettings>(key: K, value: AutoAnnounceSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const insertToken = (token: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      update('message', settings.message + token);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = settings.message.substring(0, start) + token + settings.message.substring(end);
    update('message', next);
    // Restore caret after the inserted token on next paint
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const sendNow = useCallback(async () => {
    setIsSendingNow(true);
    try {
      const res = await csrfFetch(
        `${baseUrl}/api/sources/${sourceId}/meshcore/automation/announce/send`,
        { method: 'POST' },
      );
      if (!res.ok) {
        if (res.status === 403) {
          showToast(t('automation.insufficient_permissions', 'Insufficient permissions'), 'error');
          return;
        }
        throw new Error(`Server returned ${res.status}`);
      }
      const json = await res.json();
      if (typeof json?.data?.lastRunAt === 'number') setLastRunAt(json.data.lastRunAt);
      showToast(t('meshcore.automation.announce.sent', 'Announcement sent'), 'success');
    } catch (err) {
      console.error('Failed to send MeshCore announcement:', err);
      showToast(t('meshcore.automation.announce.send_failed', 'Failed to send announcement'), 'error');
    } finally {
      setIsSendingNow(false);
    }
  }, [baseUrl, sourceId, csrfFetch, showToast, t]);

  const disabled = !settings.enabled;
  const sendNowDisabled = !canWrite || isSendingNow || channels.length === 0 || settings.channelIndexes.length === 0;

  const channelLabel = useMemo(() => {
    const sel = settings.channelIndexes
      .map(idx => channels.find(c => c.id === idx)?.name || `#${idx}`)
      .join(', ');
    return sel || t('meshcore.automation.announce.no_channels_selected', '(no channels selected)');
  }, [channels, settings.channelIndexes, t]);

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
          {t('meshcore.automation.announce.title', 'Auto-Announce')}
        </h2>
        <button
          onClick={sendNow}
          disabled={sendNowDisabled}
          className="meshcore-btn meshcore-btn-primary meshcore-send-now"
        >
          {isSendingNow
            ? t('meshcore.automation.announce.sending', 'Sending…')
            : t('meshcore.automation.announce.send_now', 'Send Now')}
        </button>
      </div>

      <div className="settings-section" style={{ opacity: settings.enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
        <p style={{ marginBottom: '1rem', color: '#666', lineHeight: 1.5, marginLeft: '1.75rem' }}>
          {t(
            'meshcore.automation.announce.description',
            'Periodically send a status message to one or more MeshCore channels. Supports interval-based or cron scheduling and an optional advert burst.',
          )}
        </p>

        {/* On-start announcement */}
        <div className="setting-item" style={{ marginTop: '1rem' }}>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={settings.announceOnStart}
              onChange={(e) => update('announceOnStart', e.target.checked)}
              disabled={disabled || !canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <span style={{ fontWeight: 'bold' }}>
              {t('meshcore.automation.announce.on_start', 'Announce on connection')}
            </span>
          </label>
          <div style={{ marginTop: '0.25rem', marginLeft: '1.75rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
            {t(
              'meshcore.automation.announce.on_start_description',
              'Fire a single announcement immediately whenever this source reconnects.',
            )}
          </div>
        </div>

        {/* Schedule type toggle */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={settings.useSchedule}
              onChange={(e) => update('useSchedule', e.target.checked)}
              disabled={disabled || !canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <span style={{ fontWeight: 'bold' }}>
              {t('meshcore.automation.announce.use_schedule', 'Use cron schedule')}
            </span>
          </label>
          <div style={{ marginTop: '0.25rem', marginLeft: '1.75rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
            {t(
              'meshcore.automation.announce.use_schedule_description',
              'When unchecked, the announcement runs every N hours. When checked, it follows a standard 5-field cron expression.',
            )}
          </div>
        </div>

        {/* Interval vs schedule */}
        {!settings.useSchedule ? (
          <div className="setting-item" style={{ marginTop: '1rem' }}>
            <label htmlFor="meshcoreAnnounceInterval">
              {t('meshcore.automation.announce.interval_label', 'Interval (hours)')}
            </label>
            <input
              id="meshcoreAnnounceInterval"
              type="number"
              value={settings.intervalHours}
              onChange={(e) => update('intervalHours', Math.max(1, parseInt(e.target.value, 10) || 1))}
              min={1}
              max={168}
              disabled={disabled || !canWrite}
              className="setting-input"
              style={{ width: '120px' }}
            />
          </div>
        ) : (
          <div className="setting-item" style={{ marginTop: '1rem' }}>
            <label htmlFor="meshcoreAnnounceSchedule">
              {t('meshcore.automation.announce.schedule_label', 'Cron schedule (min hour dom mon dow)')}
            </label>
            <input
              id="meshcoreAnnounceSchedule"
              type="text"
              value={settings.schedule}
              onChange={(e) => update('schedule', e.target.value)}
              placeholder={DEFAULT_SCHEDULE}
              disabled={disabled || !canWrite}
              className="setting-input"
              style={{ fontFamily: 'monospace', width: '260px' }}
            />
            {scheduleError && (
              <div style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: 'var(--ctp-red)' }}>
                {scheduleError}
              </div>
            )}
          </div>
        )}

        {/* Channel selection */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.announce.channels', 'Target channels')}
            <span className="setting-description">
              {t(
                'meshcore.automation.announce.channels_description',
                'The announcement is broadcast to every selected channel each run.',
              )}{' '}
              <em>{channelLabel}</em>
            </span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
            {channels.length === 0 && (
              <div style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.announce.no_channels', 'No channels loaded yet.')}
              </div>
            )}
            {channels.map((channel) => (
              <div key={channel.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  id={`meshcoreAnnounceChannel${channel.id}`}
                  checked={settings.channelIndexes.includes(channel.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      update('channelIndexes', [...settings.channelIndexes, channel.id]);
                    } else {
                      update('channelIndexes', settings.channelIndexes.filter((c) => c !== channel.id));
                    }
                  }}
                  disabled={disabled || !canWrite}
                  style={{ width: 'auto', margin: 0 }}
                />
                <label htmlFor={`meshcoreAnnounceChannel${channel.id}`} style={{ margin: 0 }}>
                  {channel.name || `Channel ${channel.id}`}
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* MeshCore scope/region for the announcement (#3833) */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label>
            {t('meshcore.automation.announce.scope_label', 'Scope')}
            <span className="setting-description">
              {t(
                'meshcore.automation.announce.scope_description',
                'Region the announcement floods to. Inherit uses each channel\'s configured scope or the source default.',
              )}
            </span>
          </label>
          <div style={{ marginTop: '0.5rem' }}>
            <ScopeSelectField
              baseUrl={baseUrl}
              sourceId={sourceId}
              idPrefix="announce"
              value={{ scopeMode: settings.scopeMode, scopeName: settings.scopeName }}
              onChange={(v) => setSettings((s) => ({ ...s, scopeMode: v.scopeMode ?? 'inherit', scopeName: v.scopeName ?? '' }))}
            />
          </div>
        </div>

        {/* Message template */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label htmlFor="meshcoreAnnounceMessage">
            {t('meshcore.automation.announce.message_label', 'Message template')}
            <span className="setting-description" style={{ display: 'block', marginTop: '0.25rem' }}>
              {t('meshcore.automation.announce.tokens_hint', 'Insert a token below, or see the reference at the top of this page.')}
            </span>
          </label>
          <textarea
            id="meshcoreAnnounceMessage"
            ref={textareaRef}
            value={settings.message}
            onChange={(e) => update('message', e.target.value)}
            disabled={disabled || !canWrite}
            className="setting-input"
            rows={3}
            style={{ fontFamily: 'monospace', resize: 'vertical', minHeight: '60px' }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.5rem' }}>
            {TOKENS.map((tok) => (
              <button
                key={tok}
                type="button"
                onClick={() => insertToken(tok)}
                disabled={disabled || !canWrite}
                className="meshcore-btn meshcore-btn-secondary"
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem', fontFamily: 'monospace' }}
              >
                {tok}
              </button>
            ))}
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <label style={{ fontSize: '0.9rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.announce.preview', 'Live preview')}:
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
              minHeight: '1.5rem',
            }}>
              {preview || settings.message}
            </div>
          </div>
        </div>

        {/* Advert burst */}
        <div className="setting-item" style={{ marginTop: '1.5rem' }}>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={settings.advertEnabled}
              onChange={(e) => update('advertEnabled', e.target.checked)}
              disabled={disabled || !canWrite}
              style={{ width: 'auto', margin: 0 }}
            />
            <span style={{ fontWeight: 'bold' }}>
              {t('meshcore.automation.announce.advert_enabled', 'Send advert after each announcement')}
            </span>
          </label>
          <div style={{ marginTop: '0.25rem', marginLeft: '1.75rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
            {t(
              'meshcore.automation.announce.advert_description',
              'Fire a MeshCore advert N seconds after each announcement so neighbours rediscover this node.',
            )}
          </div>
          {settings.advertEnabled && (
            <div style={{ marginTop: '0.5rem', marginLeft: '1.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="number"
                value={settings.advertDelaySeconds}
                onChange={(e) => update('advertDelaySeconds', Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0)))}
                min={0}
                max={600}
                disabled={disabled || !canWrite}
                style={{ width: '100px', padding: '2px 4px' }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.announce.advert_delay', 'seconds delay (0–600)')}
              </span>
            </div>
          )}
        </div>

        {lastRunAt && (
          <p style={{ fontSize: '0.85rem', color: 'var(--ctp-subtext0)', marginTop: '1rem' }}>
            {t('meshcore.automation.announce.last_run', 'Last run')}:{' '}
            {new Date(lastRunAt).toLocaleString()}
          </p>
        )}
      </div>
    </>
  );
};

export default MeshCoreAutoAnnounceSection;
